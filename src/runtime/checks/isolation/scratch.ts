import type { OperationModel } from "../../../spec/graph/types.ts"
import type { RequestOptions } from "../../../client/types.ts"
import type { Exchange } from "../../exchange.ts"
import { type Outcome, standDown } from "../../finding.ts"
import { createdRecord } from "../../world/created-record.ts"
import { type Record_, recordOf } from "../../world/records.ts"
import type { CheckContext, WriteContext } from "../core/context.ts"
import { encodeOpBody, requestSchemaOf, validBody } from "../payloads/body.ts"
import { createFresh } from "../payloads/create.ts"
import { standDownForFeatureGate } from "../planning/stand-down.ts"

/** The record a single-record answer holds (`x-entity.recordPath`), or `undefined` when there is none. */
export function readRecord(op: OperationModel, exchange: Exchange): Record_ | undefined {
	return recordOf(op, exchange.responseBody)
}

/** A record created for one mutating check: what it holds, and the create that made it. */
interface Scratch {
	id: string
	record: Record_
	exchange: Exchange
}

/**
 * A record made for one mutating check, ledgered and removed with everything else the run made.
 *
 * Mutating checks write to this, never to the cohort. A cohort record a check has patched no
 * longer matches what every read-only oracle planned against, and a check that restores it
 * afterwards still leaves the window in between — and loses the restore whenever the write it
 * is probing was itself broken.
 */
export async function scratchRecord(
	ctx: WriteContext,
	check: string,
): Promise<{ scratch: Scratch } | { outcome: Outcome }> {
	const createOp = ctx.createOp
	const schema = createOp === undefined ? null : requestSchemaOf(ctx, createOp)
	if (createOp === undefined || schema === null) {
		return { outcome: standDown("a create operation with a request body, to make a record this check may change") }
	}
	const { exchange, sent } = await createFresh(ctx, createOp, schema, ctx.actor.id)
	if (standDownForFeatureGate(ctx, createOp, exchange, check)) {
		return { outcome: standDown("a documented feature gate refused the request") }
	}
	/* The id the answer names, or one a read under it confirms: a nested related record's id is
	 * never taken for this one, since the check is about to change and delete what it names. */
	const made =
		exchange.status >= 300
			? null
			: await createdRecord({
					client: ctx.client,
					createOp,
					exchange,
					model: ctx.model,
					principal: ctx.actor.id,
					readable: (op) => op.operationId === ctx.readOp?.operationId,
					scope: ctx.scope,
					sent,
				})
	const record = made?.record ?? {}
	const id = record[ctx.identity]
	if (made === null || (typeof id !== "string" && typeof id !== "number")) {
		return {
			outcome: ctx.findings.unresolved(
				check,
				ctx.entityName,
				`a record for this check could not be made: the create answered ${exchange.status}` +
					(exchange.status < 300 ? ` without an id oat could read` : ""),
			),
		}
	}
	return { scratch: { exchange, id: String(id), record } }
}

/**
 * The request an update operation takes, in its own method: the changed fields alone for PATCH,
 * the whole representation with the changes applied for PUT — a PUT carrying one field would
 * replace the record with it.
 */
export async function updateRequest(
	ctx: CheckContext,
	updateOp: OperationModel,
	current: Record_,
	changes: Record_,
): Promise<{ method: string; options: Pick<RequestOptions, "body" | "contentType"> }> {
	const method = updateOp.method.toUpperCase()
	if (method !== "PUT") return { method, options: await encodeOpBody(ctx, updateOp, changes) }
	const schema = requestSchemaOf(ctx, updateOp)
	const properties = Object.keys((schema?.properties ?? {}) as Record<string, unknown>)
	const kept = Object.fromEntries(
		properties.filter((key) => current[key] !== undefined).map((key) => [key, current[key]]),
	)
	const whole = { ...(schema === null ? {} : validBody(ctx, schema)), ...kept, ...changes }
	return { method, options: await encodeOpBody(ctx, updateOp, whole) }
}
