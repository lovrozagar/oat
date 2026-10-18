import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import type { Exchange } from "../../../client.ts"
import { idOf, type Record_ } from "../../../world.ts"
import type { WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord, scratchRecord } from "../../isolation/scratch.ts"
import { changedValue, pickWritableStringField } from "../../payloads/body.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import { NO_RECORD } from "./records.ts"

export const patchMinimality = /* @__PURE__ */ defineCheck<{
	createOp: OperationModel
	updateOp: OperationModel
	readOp: OperationModel
}>({
	plan: (ctx) => {
		const { createOp, updateOp, readOp } = ctx
		if (updateOp === undefined || readOp === undefined || createOp === undefined) return cannot()
		/* Partial update is what PATCH promises; a PUT replaces the record by definition. */
		if (updateOp.method.toUpperCase() !== "PATCH") return cannot("an update by PATCH, which promises a partial write")
		return ready({ createOp, readOp, updateOp })
	},
	mutates: true,
	id: "patch.minimality",
	needs: "a create, a PATCH update and an item route",
	subjects: subjectsOf.update,
	async run(ctx, { createOp, readOp, updateOp }): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const id = made.scratch.id
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }
		const read: Read = (at) => ctx.client.get(fillPath(readOp.path, at), { headers: ctx.auth() })

		const before = await read(params)
		if (before.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`reading the record back returned ${before.status}, so no baseline could be established`,
			)
		}
		const original = readRecord(readOp, before)
		if (original === undefined) return ctx.findings.unresolved(this.id, ctx.entityName, NO_RECORD)
		const control = await controlBaseline(ctx, read, id)
		const settle = await read(params)
		const baseline = (settle.status < 300 ? readRecord(readOp, settle) : undefined) ?? original
		const drifting = driftingFields([createOp, updateOp], original, baseline)

		const field = pickWritableStringField(ctx, original)
		if (field === null) return standDown("no field can be patched on its own")
		const next = changedValue(ctx, field, original[field], updateOp)
		if (next === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `no other valid value for "${field}" can be made`)
		}

		const patched = await ctx.client.request("PATCH", fillPath(updateOp.path, params), {
			body: { [field]: next },
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, updateOp, patched, this.id))
			return standDown("a documented feature gate refused the request")
		if (patched.status >= 300) return ctx.findings.unresolved(this.id, ctx.entityName, "the patch was refused")

		const after = await read(params)
		const current = readRecord(readOp, after)
		if (current === undefined) return ctx.findings.unresolved(this.id, ctx.entityName, NO_RECORD)

		const moved = Object.keys(original).filter(
			(key) => key !== field && !drifting.has(key) && JSON.stringify(baseline[key]) !== JSON.stringify(current[key]),
		)
		const collateral = moved.length === 0 ? moved : await withoutControlDrift(read, readOp, control, moved)
		/* A ternary, not an early return: after the await above, v8 miscounts an if's implicit else. */
		return collateral.length === 0
			? ASSERTED
			: ctx.findings.backend(
					this.id,
					ctx.entityName,
					"PATCH changed fields the request did not mention",
					collateralDetail(field, collateral, { after: current, before: baseline }),
					[before, patched, after],
				)
	},
})

/** What a PATCH of `field` changed besides it, as the finding states it. */
function collateralDetail(
	field: string,
	collateral: readonly string[],
	record: { before: Record_; after: Record_ },
): string {
	const changes = collateral
		.slice(0, 5)
		.map((key) => `${key} ${JSON.stringify(record.before[key])} → ${JSON.stringify(record.after[key])}`)
	return (
		`patching only "${field}" also changed ${collateral.length} other field(s): ${changes.join("; ")}. ` +
		"PATCH is a partial update; behaving as PUT silently destroys data callers never sent."
	)
}

/** An item read of the record the path parameters name. */
type Read = (params: Record<string, string>) => Promise<Exchange>

/** A record never written to, read before the PATCH: where it lives and what it held. */
interface Control {
	params: Record<string, string>
	before: Exchange
}

/**
 * A control record, never written to, observed across the same window as the target.
 * Real APIs expose server-driven fields — job progress, computed counts, expiry clocks —
 * and repeated sampling cannot distinguish those from a write side effect once they
 * settle. A field that moves on the control moved on its own.
 */
async function controlBaseline(ctx: WriteContext, read: Read, id: string): Promise<Control | undefined> {
	const controlId = ctx.records.map((r) => idOf(r, ctx.identity)).find((other) => other !== undefined && other !== id)
	if (controlId === undefined) return undefined
	const params = { ...ctx.scope, ...itemParamFor(ctx, controlId) }
	return { before: await read(params), params }
}

/**
 * Fields that may move without this PATCH having moved them.
 *
 * Timestamps by name, and — more importantly — anything the document declares
 * server-generated. A generated field is by definition not the caller's to set, so finding
 * it changed proves nothing about whether PATCH behaved as PUT. Some are derived from
 * *other* entities entirely (a row count on its parent table), and since entities are
 * tested concurrently such a field can change mid-check for reasons that have nothing to
 * do with this request. The control record catches drift the whole collection shares, but
 * not drift confined to the one record under test. Whatever changed between two reads with
 * no write in between, `original` and the settled `baseline`, drifts as well.
 */
function driftingFields(writes: OperationModel[], original: Record_, baseline: Record_): Set<string> {
	const drifting = new Set<string>([
		"updated_at",
		"modified_at",
		/* A job's progress counter advances on GET without this PATCH having written it. */
		"progress",
		/*
		 * From both operations, not just the one being probed. A document commonly declares
		 * its server-owned fields on `create` — that is where they are conspicuous, being the
		 * fields a caller may not supply — and omits the same list on `update`. Reading only
		 * the update operation meant a field the document plainly called generated was still
		 * compared, and a progress counter advancing on its own read as a PATCH side effect.
		 */
		...writes.flatMap((op) => op.generated),
	])
	for (const key of Object.keys(original)) {
		if (JSON.stringify(original[key]) !== JSON.stringify(baseline[key])) drifting.add(key)
	}
	return drifting
}

/* Whatever also moved on the untouched control record was not caused by this PATCH. */
async function withoutControlDrift(
	read: Read,
	readOp: OperationModel,
	control: Control | undefined,
	collateral: string[],
): Promise<string[]> {
	if (control === undefined || control.before.status >= 300) return collateral
	const controlAfter = await read(control.params)
	if (controlAfter.status >= 300) return collateral
	const from = readRecord(readOp, control.before)
	const to = readRecord(readOp, controlAfter)
	if (from === undefined || to === undefined) return collateral
	return collateral.filter((key) => JSON.stringify(from[key]) === JSON.stringify(to[key]))
}
