/** Records as a backend answers them: plain objects, read by identity, out of single and list bodies. */

import { readPath } from "../../client/read-path.ts"

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

/** Pulls the collection out of a list body the same way seed fallback and effect checks do. */
export function recordsFromList(body: unknown, collectionKey: string | null): Record_[] {
	if (Array.isArray(body)) return body as Record_[]
	if (body !== null && typeof body === "object" && collectionKey !== null) {
		const items = (body as Record<string, unknown>)[collectionKey]
		return Array.isArray(items) ? (items as Record_[]) : []
	}
	return []
}
