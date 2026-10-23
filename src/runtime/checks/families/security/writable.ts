/*
 * A write probe's harmless body: the record as it is now, cut to what the operation's request body
 * accepts from any writer. Sending the whole record would carry `readOnly` fields (an id, a
 * timestamp) that a strict API rightly refuses with a 400, and x-privileged ones it refuses with a
 * 403, before it ever judges who is writing.
 */

import type { OperationModel } from "../../../../spec/graph/types.ts"
import { requestContent } from "../../../../spec/collection/request.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import { ordinaryRequestSchema } from "../../../fixture.ts"
import { type Record_, recordOf } from "../../../world/records.ts"
import type { OperationContext, WriteTarget } from "../../core/operation-context.ts"

/** The GET that shares the operation's path: how the record it writes is read back. */
export function readOf(ctx: OperationContext): OperationModel | undefined {
	return ctx.model.operations.find((op) => op.method.toUpperCase() === "GET" && op.path === ctx.operation.path)
}

/**
 * The target's record as the stage read it back: already out of any envelope its read declares, so
 * never unwrapped again. Undefined when the read showed no record.
 */
export function currentOf(target: WriteTarget): Record_ | undefined {
	const { current } = target
	return typeof current === "object" && current !== null && !Array.isArray(current) ? (current as Record_) : undefined
}

/** The record an answer of the record's read holds (`x-entity.recordPath`), or undefined. */
export function recordAt(ctx: OperationContext, body: unknown): Record_ | undefined {
	return recordOf(readOf(ctx) ?? ctx.operation, body)
}

/**
 * `record`'s properties that any writer may send by the operation's request schema: declared, not
 * `readOnly`, and not an optional property marked x-privileged, which only the highest rank may set.
 * A schema that names no properties says nothing to cut by, so the record goes as it is.
 */
export function writableBody(ctx: OperationContext, record: Record_): Record_ {
	/* The model holds every operation it lists. */
	const raw = ctx.model.rawOperations.get(ctx.operation.operationId) as OperationObject
	const content = requestContent(raw)
	if (content?.schema.properties === undefined) return { ...record }
	const properties = ordinaryRequestSchema(content.schema).properties as Record<string, unknown>
	return Object.fromEntries(Object.entries(record).filter(([name]) => Object.hasOwn(properties, name)))
}
