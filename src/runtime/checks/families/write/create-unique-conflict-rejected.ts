import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import type { Exchange } from "../../../client.ts"
import { FencedError } from "../../../fence.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import {
	bodyPropertyNames,
	collisionCreateBody,
	idempotencyHeaderRequired,
	probeableUniqueSets,
	uniqueProbeHeaders,
	uniquifyProbeBody,
} from "../../../unique.ts"
import { idOf, isPlanLimitResponse, type Record_ } from "../../../world.ts"
import type { WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord } from "../../isolation/scratch.ts"
import { encodeOpBody, requestSchemaOf, validBody } from "../../payloads/body.ts"
import { reserveClientIdentity, saltOf } from "../../payloads/identity.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import { pageSize, q } from "../../query/capabilities.ts"
import { type Listing, listAll } from "../../sets/compare.ts"
import { liveRecord } from "./records.ts"

async function teardownCreatedId(ctx: WriteContext, id: string): Promise<void> {
	const deleteOp = ctx.deleteOp ?? ctx.model.byOperationId.get(ctx.model.entities.get(ctx.entityName)?.delete ?? "")
	if (deleteOp === undefined) return
	try {
		await ctx.client.request("DELETE", fillPath(deleteOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
			headers: ctx.auth(),
		})
	} catch (error) {
		/* A fenced delete is reported, not skipped: the global teardown lists it as a leftover. */
		if (error instanceof FencedError) throw error
		/* A leftover row is worse than a teardown 404. */
	}
}

export const uniqueConflictCreate = defineCheck<{
	createOp: OperationModel
	first: Record_
	schema: Record<string, unknown>
	sets: string[][]
}>({
	plan: (ctx) => {
		const createOp = ctx.uniqueCreateOp
		const [first] = ctx.records
		if (createOp === undefined || (ctx.uniqueSets?.length ?? 0) === 0 || first === undefined) return cannot()
		/* A create with no documented body has no column to collide on. */
		const schema = requestSchemaOf(ctx, createOp)
		if (schema === null) return cannot()
		const sets = probeableUniqueSets(createOp, ctx.model, "create", ctx.uniqueSets)
		return sets.length === 0 ? cannot() : ready({ createOp, first, schema, sets })
	},
	/* Reads whole sets across pages, so a walk that skips or repeats records corrupts them. */
	dependsOn: ["pagination.page-walk-covers-set"],
	id: "create.unique-conflict-rejected",
	mutates: true,
	needs: "x-unique on create with at least one probeable column set, and a known row",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, first, schema, sets }): Promise<Outcome> {
		const bodyCols = bodyPropertyNames(createOp, ctx.model)
		const path = fillPath(createOp.path, ctx.scope)
		const required = idempotencyHeaderRequired(createOp, ctx.model)
		const listLimit = pageSize(ctx)
		const before = await listAll(ctx, q(ctx, { limit: listLimit }))
		/* A growth in the collection is only visible when both reads cover all of it. */
		const listResolved = before.exchange.status < 400 && before.complete
		const evidence: Exchange[] = listResolved ? [before.exchange] : []
		const known = (await liveRecord(ctx, idOf(first, ctx.identity))) ?? first
		const probe = {
			before,
			bodyCols,
			check: this.id,
			createOp,
			evidence,
			known,
			listLimit,
			listResolved,
			path,
			required,
			schema,
		}
		for (const [index, set] of sets.entries()) await probeCreateSet(ctx, probe, set, index)
		return ASSERTED
	},
})

/** What every unique probe on one create shares; `evidence` gathers across the sets. */
interface CreateProbe {
	check: string
	createOp: OperationModel
	schema: Record<string, unknown>
	bodyCols: ReadonlySet<string>
	path: string
	required: boolean
	listLimit: number
	before: Listing
	listResolved: boolean
	evidence: Exchange[]
	known: Record_
}

/** A create colliding with `known` on `set` alone, or `null` when no such body can be made. */
async function sendCollision(
	ctx: WriteContext,
	probe: CreateProbe,
	set: string[],
	index: number,
): Promise<Exchange | null> {
	const { createOp, schema } = probe
	const salt = `u${ctx.nonce}${index}${saltOf(ctx)}`
	/* Distinct unique columns, then an identity no record holds: only `set` may collide. */
	const base = reserveClientIdentity(
		ctx,
		uniquifyProbeBody(validBody(ctx, schema), ctx.uniqueSets, schema, salt),
		schema,
		salt,
	)
	const body = collisionCreateBody(base, probe.known, set, ctx.scope, probe.bodyCols, createOp.generated)
	if (body === null) return null
	const headers = uniqueProbeHeaders(
		ctx.auth(),
		createOp.idempotencyHeader,
		probe.required,
		`oat-unique-${ctx.entityName}-${ctx.seed}-${index}`,
	)
	const encoded = await encodeOpBody(ctx, createOp, body)
	return ctx.client.request("POST", probe.path, { ...encoded, headers, operationId: createOp.operationId })
}

async function probeCreateSet(ctx: WriteContext, probe: CreateProbe, set: string[], index: number): Promise<void> {
	const { check, createOp } = probe
	const sent = await sendCollision(ctx, probe, set, index)
	if (sent === null) return
	probe.evidence.push(sent)
	if (standDownForFeatureGate(ctx, createOp, sent, check)) return
	if (isPlanLimitResponse(sent.status, sent.responseBody)) {
		ctx.findings.gap(
			check,
			ctx.entityName,
			`${createOp.operationId} did not apply`,
			`${createOp.operationId} returned ${sent.status} (plan limit) on a unique-conflict ` +
				"probe, so uniqueness was not observed.",
		)
		return
	}
	const after = await listAll(ctx, q(ctx, { limit: probe.listLimit }))
	if (after.exchange.status < 400 && after.complete) probe.evidence.push(after.exchange)
	await judgeCreateProbe(ctx, probe, set, { after, sent })
}

async function judgeCreateProbe(
	ctx: WriteContext,
	probe: CreateProbe,
	set: string[],
	{ after, sent }: { after: Listing; sent: Exchange },
): Promise<void> {
	const { before, check, createOp } = probe
	if (sent.status === 409) {
		if (
			probe.listResolved &&
			after.exchange.status < 400 &&
			after.complete &&
			after.items.length > before.items.length
		) {
			ctx.findings.backend(
				check,
				ctx.entityName,
				"a unique-conflict 409 still grew the collection",
				`POST colliding ${set.join(", ")} returned 409 but the list grew from ` +
					`${before.items.length} to ${after.items.length}.`,
				[before.exchange, sent, after.exchange],
			)
		}
		return
	}
	if (sent.status >= 200 && sent.status < 300) {
		const id = idOf(ctx.createOp === undefined ? undefined : readRecord(ctx.createOp, sent), ctx.identity)
		if (id !== undefined) await teardownCreatedId(ctx, id)
		ctx.findings.backend(
			check,
			ctx.entityName,
			"a duplicate unique-set create was accepted",
			`${createOp.operationId} returned ${sent.status} for a second create colliding ` +
				`${set.join(", ")}. A documented unique constraint must be 409, not 2xx.`,
			probe.evidence.slice(-3),
		)
		return
	}
	if (sent.status >= 500) {
		ctx.findings.backend(
			check,
			ctx.entityName,
			"a duplicate unique-set create drew a server error",
			`${createOp.operationId} returned ${sent.status} for a second create colliding ` +
				`${set.join(", ")}. A documented unique constraint must be refused with 409, not crash.`,
			[sent],
		)
		return
	}
	ctx.findings.unresolved(
		check,
		ctx.entityName,
		`unique probe for ${set.join(", ")} returned ${sent.status}, which is not a 409 unique conflict`,
	)
}
