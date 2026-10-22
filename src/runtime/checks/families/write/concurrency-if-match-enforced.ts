import { defineCheck } from "../../core/define.ts"
import type { RequestOptions } from "../../../../client/types.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, asserted, type Outcome, standDown } from "../../../finding.ts"
import { ordinaryRequestSchema } from "../../../fixture.ts"
import type { Record_ } from "../../../world/records.ts"
import type { WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord, scratchRecord, updateRequest } from "../../isolation/scratch.ts"
import { requestSchemaOf } from "../../payloads/body.ts"
import { standDownForFeatureGate, standDownForRateLimit } from "../../planning/stand-down.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import { NO_RECORD } from "./records.ts"

/** What the check runs on: the item read that tags a version, and the update that takes one. */
interface Plan {
	readOp: OperationModel
	updateOp: OperationModel
	/** The If-Match header, under the spelling the update declares. */
	header: string
}

/** One record's versions, and how to reach it. */
interface Versions extends Plan {
	ctx: WriteContext
	check: string
	readPath: string
	updatePath: string
}

/** The record as read at one moment: its representation, its ETag, and the answer that carried both. */
interface Version {
	record: Record_
	etag: string
	exchange: Exchange
}

/** One update, encoded once, so the current and the stale request carry the same body. */
type Write = Awaited<ReturnType<typeof updateRequest>>

/**
 * An update that names, in `If-Match`, a version the record no longer has must be refused with 412.
 *
 * Optimistic concurrency rests on it: a client reads, edits, and writes back under the ETag it read,
 * trusting the server to refuse the write if anyone changed the record in between. A server that
 * ignores the header applies the write over the other change, and tells the caller it succeeded.
 *
 * Both updates send the record's own writable state, so the stale one changes nothing a reader could
 * see even when it is wrongly applied; whether it was applied is told by the ETag the record reads
 * back with afterwards.
 */
export const ifMatchEnforced = defineCheck<Plan>({
	plan: (ctx) => {
		const { readOp, updateOp } = ctx
		if (readOp === undefined || updateOp === undefined || ctx.createOp === undefined) return cannot()
		if (!readOp.etag) return cannot("an item read whose success response declares an ETag header")
		if (updateOp.ifMatch === null) return cannot("an update that declares an If-Match header")
		return ready({ header: updateOp.ifMatch, readOp, updateOp })
	},
	id: "concurrency.if-match-enforced",
	needs: "a create, an item read that declares an ETag, and an update that declares If-Match",
	mutates: true,
	subjects: subjectsOf.writeAndRead,
	async run(ctx, plan): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
		return outdate({
			...plan,
			check: this.id,
			ctx,
			readPath: fillPath(plan.readOp.path, params),
			updatePath: fillPath(plan.updateOp.path, params),
		})
	},
})

/** Moves the record past the version it was read at, then updates it again under that version. */
async function outdate(versions: Versions): Promise<Outcome> {
	const { check, ctx, updateOp } = versions
	const before = await readVersion(versions, "before any update")
	if ("outcome" in before) return before.outcome
	/* RFC 9110 §13.1.1: If-Match compares strongly, so a weak tag never matches, current or not. */
	if (before.etag.startsWith("W/")) return standDown("a weak ETag cannot satisfy If-Match")
	const write = await updateRequest(ctx, updateOp, before.record, writableState(ctx, updateOp, before.record))
	const current = await updateUnder(versions, write, before.etag)
	const refusedCurrent = refusal(versions, current)
	if (refusedCurrent !== undefined) return refusedCurrent
	if (current.status >= 300) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			`an update naming the record's current ETag answered ${current.status}, so no accepted write left it stale`,
		)
	}
	const after = await readVersion(versions, "after the first update")
	if ("outcome" in after) return after.outcome
	if (after.etag === before.etag) {
		return standDown("the update left the ETag unchanged, so the ETag it named never went stale")
	}
	const stale = await updateUnder(versions, write, before.etag)
	return refusal(versions, stale) ?? judgeStale(versions, { after, before, stale })
}

/** The versions around the stale update: as first read, after the accepted update, and its answer. */
interface Stale {
	before: Version
	after: Version
	stale: Exchange
}

/** Reads the record back after the stale update: a 412 or an already-applied 2xx must have changed nothing. */
async function judgeStale(versions: Versions, { after, before, stale }: Stale): Promise<Outcome> {
	const { check, ctx } = versions
	const refused = stale.status === 412
	if (!refused && stale.status >= 300) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			`an update naming a stale ETag answered ${stale.status}, neither 412 nor a success`,
		)
	}
	const last = await readVersion(versions, "after the stale update")
	if ("outcome" in last) return last.outcome
	if (last.etag === after.etag) {
		return refused
			? ASSERTED
			: asserted(
					`an update naming a stale ETag answered ${stale.status} and left the record as it was, which ` +
						"RFC 9110 allows when the change it asks for is already applied",
				)
	}
	const history =
		`the record was read with ETag ${before.etag} and updated under If-Match: ${before.etag}, which moved its ` +
		`ETag to ${after.etag}. A second update under the same If-Match: ${before.etag}, a version the record no ` +
		"longer has, "
	return ctx.findings.backend(check, ctx.entityName, {
		summary: refused
			? "an update refused with 412 was applied anyway"
			: "an update naming a stale ETag in If-Match was applied",
		detail: refused
			? `${history}answered 412 Precondition Failed, yet the record's ETag moved from ${after.etag} to ` +
				`${last.etag}: the write the server refused still landed.`
			: `${history}answered ${stale.status}, and the record's ETag moved again, to ${last.etag}. RFC 9110 ` +
				"requires a 412 when If-Match names no current version, so a client relying on it to keep from " +
				"overwriting another's change overwrites it, and is told the write succeeded.",
		evidence: [stale, last.exchange],
	})
}

/** The record as read now, with its ETag, or why it could not be read. */
async function readVersion(versions: Versions, when: string): Promise<Version | { outcome: Outcome }> {
	const { check, ctx } = versions
	const exchange = await ctx.client.get(versions.readPath, { as: { principal: ctx.actor.id } })
	if (exchange.status >= 300) {
		return {
			outcome: ctx.findings.unresolved(check, ctx.entityName, `reading the record ${when} returned ${exchange.status}`),
		}
	}
	const record = readRecord(versions.readOp, exchange)
	if (record === undefined) return { outcome: ctx.findings.unresolved(check, ctx.entityName, NO_RECORD) }
	const etag = exchange.responseHeaders["etag"]
	if (etag === undefined) {
		return { outcome: ctx.findings.unresolved(check, ctx.entityName, `the item read ${when} carried no ETag`) }
	}
	return { etag, exchange, record }
}

/** Sends the update under `If-Match: etag`. */
function updateUnder(versions: Versions, write: Write, etag: string): Promise<Exchange> {
	const { ctx, header } = versions
	const options: RequestOptions = { ...write.options, as: { principal: ctx.actor.id }, headers: { [header]: etag } }
	return ctx.client.request(write.method, versions.updatePath, options)
}

/** Why an update cannot be judged — a documented feature gate or a rate limit — or `undefined`. */
function refusal(versions: Versions, exchange: Exchange): Outcome | undefined {
	const { check, ctx, updateOp } = versions
	if (standDownForFeatureGate(ctx, updateOp, exchange, check)) {
		return standDown("a documented feature gate refused the request")
	}
	if (standDownForRateLimit(ctx, exchange, check)) return standDown("the request was rate limited")
	return undefined
}

/**
 * The record's own values for every field an ordinary update body may carry: never its identity, nor
 * a field the update cannot change. Written back, they leave the record as it was.
 */
function writableState(ctx: WriteContext, updateOp: OperationModel, record: Record_): Record_ {
	const schema = requestSchemaOf(ctx, updateOp)
	const ordinary = schema === null ? {} : (ordinaryRequestSchema(schema) as Record<string, unknown>)
	const fixed = new Set([ctx.identity, ...updateOp.immutable, ...updateOp.generated])
	const fields = Object.keys((ordinary.properties ?? {}) as Record<string, unknown>)
	return Object.fromEntries(
		fields.filter((field) => !fixed.has(field) && record[field] !== undefined).map((field) => [field, record[field]]),
	)
}
