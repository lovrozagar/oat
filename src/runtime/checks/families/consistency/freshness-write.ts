/**
 * The write a freshness check judges a read against: a scratch record of its own, read once as a
 * client would (a cache holds nothing to go stale until something has read through it), then
 * updated or deleted. It answers how a later read shows the write.
 */

import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { type Outcome, standDown } from "../../../finding.ts"
import type { WriteContext } from "../../core/context.ts"
import { readRecord, scratchRecord } from "../../isolation/scratch.ts"
import { changedValue, pickWritableStringField, requestSchemaOf, validBody } from "../../payloads/body.ts"
import { itemParamFor } from "../../planning/subjects.ts"

export type WriteKind = "update" | "delete"

export type Step<T> = T | { outcome: Outcome }

export interface FreshnessWrite {
	kind: WriteKind
	/** The read's path, filled for the scratch record. */
	path: string
	write: Exchange
	/** Whether a read's answer shows the write: the new value, or the record gone. */
	shows: (answer: Exchange) => boolean
}

/**
 * How a read after the write is sent: after a delete it expects the record gone, so it is a probe,
 * whose status no documentation judge grades. A 400 an API answers for a missing id is the delete
 * checks' to report, not noise of this read's making.
 */
export function readAfter(written: Pick<FreshnessWrite, "kind">): { probe?: true } {
	return written.kind === "delete" ? { probe: true } : {}
}

/** The kinds of write the entity has, update first. */
export function writeKinds(ctx: Pick<WriteContext, "updateOp" | "deleteOp">): WriteKind[] {
	return [
		...(ctx.updateOp === undefined ? [] : ["update" as const]),
		...(ctx.deleteOp === undefined ? [] : ["delete" as const]),
	]
}

export async function primedWrite(
	ctx: WriteContext,
	ask: { check: string; kind: WriteKind; readOp: OperationModel },
): Promise<Step<FreshnessWrite>> {
	const made = await scratchRecord(ctx, ask.check)
	if ("outcome" in made) return made
	const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
	const path = fillPath(ask.readOp.path, params)
	const primed = await ctx.client.get(path, { as: { principal: ctx.actor.id }, cache: "use" })
	if (primed.status >= 300) {
		return {
			outcome: ctx.findings.unresolved(ask.check, ctx.entityName, `reading the record returned ${primed.status}`),
		}
	}
	const written =
		ask.kind === "update" ? await update(ctx, { params, primed, readOp: ask.readOp }) : await remove(ctx, params)
	return "outcome" in written ? written : { ...written, kind: ask.kind, path }
}

type Written = Step<{ write: Exchange; shows: (answer: Exchange) => boolean }>

async function update(
	ctx: WriteContext,
	{ params, primed, readOp }: { params: Record<string, string>; primed: Exchange; readOp: OperationModel },
): Promise<Written> {
	const updateOp = ctx.updateOp as OperationModel
	const original = readRecord(readOp, primed)
	const field = original === undefined ? null : pickWritableStringField(ctx, original)
	if (original === undefined || field === null) return { outcome: standDown("no field the update can change") }
	const next = changedValue(ctx, field, original[field], updateOp)
	if (next === undefined) return { outcome: standDown(`no other valid value for "${field}"`) }
	const schema = requestSchemaOf(ctx, updateOp)
	/* A PUT replaces the record, so it carries a whole valid body; a PATCH only the field. */
	const whole = updateOp.method.toUpperCase() === "PATCH" || schema === null ? {} : validBody(ctx, schema)
	const write = await ctx.client.request(updateOp.method, fillPath(updateOp.path, params), {
		as: { principal: ctx.actor.id },
		body: { ...whole, [field]: next },
	})
	if (write.status >= 300) return { outcome: standDown(`the update answered ${write.status}`) }
	return { shows: (answer) => JSON.stringify(readRecord(readOp, answer)?.[field]) === JSON.stringify(next), write }
}

async function remove(ctx: WriteContext, params: Record<string, string>): Promise<Written> {
	const deleteOp = ctx.deleteOp as OperationModel
	const write = await ctx.client.request(deleteOp.method, fillPath(deleteOp.path, params), {
		as: { principal: ctx.actor.id },
	})
	if (write.status >= 300) return { outcome: standDown(`the delete answered ${write.status}`) }
	return { shows: (answer) => answer.status === 404 || answer.status === 410, write }
}
