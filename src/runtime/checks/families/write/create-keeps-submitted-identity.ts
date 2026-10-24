import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { answeredIdOf } from "../../../created-id.ts"
import { idOf, type Record_ } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord } from "../../isolation/scratch.ts"
import { requestSchemaOf } from "../../payloads/body.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import type { JsonSchema } from "../../../../spec/types.ts"

/** How many creates with distinct client-chosen ids `create.keeps-submitted-identity` judges. */
const KEPT_IDENTITY_SAMPLES = 3

/**
 * Up to `max` successful creates on this entity's resolved path, oldest first, hydrated.
 *
 * Prefix matching is not enough: two entities can share a prefix up to their first path
 * parameter (`/v1/projects/{project_id}/tables` and `.../tables/{table_id}/rows` both truncate
 * to `/v1/projects/`), which silently pairs one entity's response with another's schema.
 */
async function createExchanges(ctx: CheckContext, max: number): Promise<Exchange[]> {
	const createOp = ctx.createOp
	if (createOp === undefined) return []
	let resolved: string
	try {
		resolved = fillPath(createOp.path, ctx.scope)
	} catch {
		return []
	}
	const found = ctx.client
		.exchangesFor(createOp.operationId)
		.filter((e) => e.status < 300 && ctx.client.relativePath(e.url) === resolved)
		.slice(0, max)
	return Promise.all(found.map((e) => ctx.client.hydrate(e)))
}

/**
 * A create that takes the record's identity from the client must store the record under it. An
 * acknowledgment-only create gives nothing back to compare, so the record is read back under the
 * id it was sent; a create that answers with an identity must answer with the one it was sent.
 */
export const createKeepsSubmittedIdentity: Check<{ readOp: OperationModel }> = defineCheck<{ readOp: OperationModel }>({
	plan: (ctx) => {
		const createOp = ctx.createOp
		const readOp = ctx.readOp
		if (createOp === undefined || readOp === undefined) return cannot()
		const property = (requestSchemaOf(ctx, createOp)?.properties as Record<string, JsonSchema> | undefined)?.[
			ctx.identity
		]
		/* Only an identity the client writes can be kept or ignored. */
		if (property === undefined || property.readOnly === true) return cannot()
		return ready({ readOp })
	},
	dependsOn: [],
	id: "create.keeps-submitted-identity",
	needs: "a create that takes the record's identity from the client, and an item read",
	subjects: subjectsOf.create,
	async run(ctx, { readOp }): Promise<Outcome> {
		const creates = await sampledCreates(ctx)
		if (creates.length === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no create carrying a client-chosen identity was observed",
			)
		}
		for (const create of creates) {
			const failed = await judgeCreate(ctx, this.id, readOp, create)
			if (failed !== undefined) return failed
		}
		return ASSERTED
	},
})

/** One observed create and the identity it was sent. */
interface SentCreate {
	created: Exchange
	sent: string | number
}

/*
 * A server issuing its own ids from a counter can issue, by chance, the very one a create
 * sent: that create looks kept. Several creates with distinct ids all coinciding cannot.
 */
async function sampledCreates(ctx: CheckContext): Promise<SentCreate[]> {
	const creates: SentCreate[] = []
	for (const created of await createExchanges(ctx, KEPT_IDENTITY_SAMPLES * 4)) {
		const body = created.requestBody
		const sent =
			body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record_)[ctx.identity] : undefined
		if (typeof sent !== "string" && typeof sent !== "number") continue
		if (creates.some((seen) => String(seen.sent) === String(sent))) continue
		creates.push({ created, sent })
		if (creates.length === KEPT_IDENTITY_SAMPLES) break
	}
	return creates
}

/** The finding when this create did not keep the identity it was sent, or `undefined` when it did. */
async function judgeCreate(
	ctx: CheckContext,
	check: string,
	readOp: OperationModel,
	{ created, sent }: SentCreate,
): Promise<Outcome | undefined> {
	const answered = answeredIdOf({
		createOp: { entity: ctx.entityName },
		exchange: created,
		identity: ctx.identity,
		model: ctx.model,
	})
	if (answered !== undefined) {
		if (String(answered) === String(sent)) return undefined
		return ctx.findings.backend(check, ctx.entityName, {
			summary: "create answers with an identity other than the one it was sent",
			detail:
				`"${ctx.identity}" was sent ${JSON.stringify(sent)} and the create answered ${JSON.stringify(answered)}. ` +
				"A client that chose the id can no longer find its record by it.",
			evidence: [created],
		})
	}
	const read = await ctx.client.get(fillPath(readOp.path, { ...ctx.scope, ...itemParamFor(ctx, String(sent)) }), {
		as: { principal: ctx.actor.id },
		operationId: readOp.operationId,
	})
	const record = readRecord(readOp, read)
	if (read.status >= 200 && read.status < 300 && idOf(record, ctx.identity) === String(sent)) return undefined
	return ctx.findings.backend(check, ctx.entityName, {
		summary: "create acknowledged a record that is not under the identity it was sent",
		detail:
			`"${ctx.identity}" was sent ${JSON.stringify(sent)}; the create answered ${created.status} without an ` +
			`identity, and the read under that id returned ${read.status}. The record exists, if at all, under an id ` +
			"the client was never told.",
		evidence: [created, read],
	})
}
