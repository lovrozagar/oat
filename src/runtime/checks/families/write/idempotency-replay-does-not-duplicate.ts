import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { listedIds } from "../../../proven-id.ts"
import { createdRecordOf } from "../../../created-id.ts"
import type { CheckContext, WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { encodeOpBody, requestSchemaOf, validBody } from "../../payloads/body.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { ids } from "../../sets/list.ts"
import { readSet, type SetRead } from "../../sets/read.ts"
import { confirmedIdentity } from "./records.ts"

/**
 * Replaying a create with the same idempotency key must not create a second record.
 *
 * An API that publishes the header has made a promise, and it is a promise clients rely on to
 * make retries safe: a timeout, a proxy replay or a double-click all resend the same request. If
 * the key is accepted and ignored, every one of those silently duplicates whatever the record
 * represents — a charge, an order, a transfer. Nothing about a single request reveals this;
 * it only shows up when the request is actually replayed.
 *
 * Both halves are asserted, because either alone is satisfiable by a broken backend: the replay
 * must return the *original* record, and the collection must not have grown.
 */
export const idempotentReplay = defineCheck<{
	createOp: OperationModel
	header: string
	schema: Record<string, unknown>
}>({
	plan: (ctx) => {
		const createOp = ctx.createOp
		const header = createOp?.idempotencyHeader
		if (createOp === undefined || header == null) return cannot()
		const schema = requestSchemaOf(ctx, createOp)
		return schema === null
			? cannot("a create operation with a request body to replay")
			: ready({ createOp, header, schema })
	},
	dependsOn: ["pagination.page-walk-covers-set", "list.read-after-write", "create.persists-submitted-fields"],
	id: "idempotency.replay-does-not-duplicate",
	mutates: true,
	needs: "a create operation declaring an idempotency-key header",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, header, schema }): Promise<Outcome> {
		const body = validBody(ctx, schema)
		/* The nonce keeps a second run from replaying the first run's request — and getting the
		 * first run's record back, which reads as a pass while proving nothing. */
		const key = `oat-idem-${ctx.nonce}-${ctx.entityName}`
		const path = fillPath(createOp.path, ctx.scope)
		const headers = { ...ctx.auth(), [header]: key }

		const encoded = await encodeOpBody(ctx, createOp, body)
		const first = await ctx.client.request("POST", path, { ...encoded, headers })
		const firstRefused = refusal(ctx, this.id, createOp, {
			exchange: first,
			reason: (status) => `the first create returned ${status}, so there was nothing to replay`,
		})
		if (firstRefused !== undefined) return firstRefused
		/* An acknowledgement-only create names the record by the id it was sent, once a read shows it. */
		const acknowledged = identityOf(ctx, first) === undefined
		const firstId = identityOf(ctx, first) ?? (await confirmedIdentity(ctx, ctx.client, body))?.id
		if (firstId === undefined) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`the create response carries no "${ctx.identity}", so a replay cannot be matched to it`,
			)
		}
		const before = await readSet(ctx, {}, { fresh: true })
		const second = await ctx.client.request("POST", path, { ...encoded, headers })
		const secondRefused = refusal(ctx, this.id, createOp, {
			exchange: second,
			reason: (status) => `the replay returned ${status}; a repeated key must be answered, not refused`,
		})
		if (secondRefused !== undefined) return secondRefused
		return judgeReplay({ acknowledged, before, check: this.id, ctx, first, firstId, header, key, second })
	},
})

/** One create and its replay under the same key, as sent and answered. */
interface Replay {
	ctx: WriteContext
	check: string
	header: string
	key: string
	first: Exchange
	firstId: string
	acknowledged: boolean
	second: Exchange
	/** The collection read between the two creates. */
	before: SetRead
}

function identityOf(ctx: CheckContext, exchange: Exchange): string | undefined {
	const value = createdRecordOf(exchange.responseBody ?? {}, ctx.identity, exchange.requestBody)[ctx.identity]
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined
}

/** Why a create cannot be judged — a documented feature gate, or any status from 300 up — or `undefined`. */
function refusal(
	ctx: CheckContext,
	check: string,
	createOp: OperationModel,
	answered: { exchange: Exchange; reason: (status: number) => string },
): Outcome | undefined {
	const { exchange } = answered
	if (standDownForFeatureGate(ctx, createOp, exchange, check))
		return standDown("a documented feature gate refused the request")
	if (exchange.status < 300) return undefined
	return ctx.findings.unresolved(check, ctx.entityName, answered.reason(exchange.status))
}

function judgeReplay(replay: Replay): Promise<Outcome> | Outcome {
	const { check, ctx, first, firstId, header, key, second } = replay
	/* The same key and body under an acknowledgement-only create name the same record; whether the
	 * replay made a second one is then the collection's to say, below. */
	const secondId = identityOf(ctx, second) ?? (replay.acknowledged ? firstId : undefined)
	if (secondId === undefined) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			`the replay's response carries no "${ctx.identity}", so it cannot be matched to the original`,
		)
	}
	if (firstId === secondId) return judgeGrowth(replay)
	return ctx.findings.backend(check, ctx.entityName, {
		summary: "replaying a request with the same idempotency key created a second record",
		detail:
			`two identical POSTs carrying ${header}: "${key}" produced ${ctx.entityName} ${firstId} ` +
			`and ${secondId}. The header is declared, so clients will retry on timeouts assuming ` +
			"it protects them; every such retry silently duplicates the record.",
		evidence: [first, second],
	})
}

/** The other half: answering with the original record while still inserting a second. */
async function judgeGrowth(replay: Replay): Promise<Outcome> {
	const { before, check, ctx, first, firstId, header, key, second } = replay
	const after = await readSet(ctx, {}, { fresh: true })
	if (before.status !== "ok" || after.status !== "ok" || !before.complete || !after.complete) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			"the collection could not be read whole around the replay, so growth was not ruled out",
		)
	}
	if (after.items.length <= before.items.length) return ASSERTED
	/* The twin the replay made is named only by the listing: it is the run's to remove. */
	const existed = new Set(ids(before.items, ctx.identity))
	const twins = ids(after.items, ctx.identity).filter((id) => !existed.has(id))
	for (const id of listedIds(twins)) ctx.recordCreated?.(ctx.entityName, id, { ...ctx.scope }, second.principal)
	return ctx.findings.backend(check, ctx.entityName, {
		summary: "replaying a request with the same idempotency key grew the collection",
		detail:
			`the replay carrying ${header}: "${key}" answered with the original ${ctx.entityName} ${firstId}, ` +
			`yet the collection went from ${before.items.length} to ${after.items.length} records. The ` +
			"response hides a duplicate the retry still made.",
		evidence: [first, second, before.last.exchange, after.last.exchange],
	})
}
