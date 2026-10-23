/** Records as a backend answers them: plain objects, read by identity, out of single and list bodies. */

import { readPath } from "../../client/read-path.ts"
import type { CollectionShape } from "../../spec/collection/shape.ts"

export type Record_ = Record<string, unknown>

export function isScalarId(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number"
}

export function isPlainRecord(value: unknown): value is Record_ {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The record a single-record answer holds: the object at the operation's declared
 * `x-entity.recordPath`, or the body itself when nothing is declared. `undefined` when there is
 * none — an update that answers `{ success, id, message }` holds no record, and comparing against
 * an empty one would report every field dropped.
 */
export function recordOf(op: { recordPath: string | null }, body: unknown): Record_ | undefined {
	const record = op.recordPath === null ? body : readPath(body, op.recordPath)
	return isPlainRecord(record) ? record : undefined
}

/**
 * A record's identity as text, or `undefined` when it has none to give. Every id oat puts in a
 * request goes through here (lint rule `oat/id-through-reader`): `String(record[identity])` on a
 * record without one is the text "undefined", and a request made from it means nothing.
 */
export function idOf(record: Record_ | undefined, identity: string): string | undefined {
	const value = record?.[identity]
	return isScalarId(value) ? String(value) : undefined
}

/** Where a list body keeps its records: the rows' key (null for a bare array), and each record within a row. */
export type RowsAt = Pick<CollectionShape, "key" | "within">

/**
 * The records a list body holds: a bare array, or the array under the collection key, each row
 * read at `within` when the rows wrap their record (`$.hits[*].document`). A row that holds no
 * record is skipped; the response-schema checks report it, and no check reads a field off it.
 */
export function recordsFromList(body: unknown, rows: RowsAt | null): Record_[] {
	const key = rows?.key ?? null
	const list = Array.isArray(body) ? body : key === null || !isPlainRecord(body) ? undefined : body[key]
	if (!Array.isArray(list)) return []
	const within = rows?.within ?? []
	return list.map((row) => within.reduce(field, row)).filter(isPlainRecord)
}

/* One property down, or nothing below what is not a record. */
function field(node: unknown, name: string): unknown {
	return isPlainRecord(node) ? node[name] : undefined
}
