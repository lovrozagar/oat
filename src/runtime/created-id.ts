/**
 * The id a create's answer gives the record it made.
 *
 * Teardown deletes by this id, so where it comes from decides whether a delete removes oat's own
 * row or somebody else's. A declared `x-entity.createdIdFrom`, or the identity at the top of the
 * answer, names the record by contract. Anything else is a candidate: the record under an
 * envelope, or a conventional id key found by walking the answer — which can just as well be a
 * related record's (`Status: { ID: 1 }`). A candidate counts only once a read under it shows what
 * was sent (`confirmSubmitted`).
 */

import { createdIdKeys, findCreatedId } from "./effects.ts"
import { readPath } from "./path.ts"
import { type ProvenId, createdId } from "./proven-id.ts"

type Record_ = Record<string, unknown>

function isScalarId(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number"
}

function isPlainRecord(value: unknown): value is Record_ {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Keys a create may wrap the record it made in: `{ success, id, data: { ... } }`. */
const CREATE_ENVELOPE_KEYS = ["data", "item", "result", "record"] as const

/**
 * The record a create answered with. Some creates wrap it — `{ success, id, data: { ID, ... } }` —
 * and taking the envelope for the record compares the wrong object and loses the id. The record
 * is the top level or the object under an envelope key, whichever holds more of what was sent, so
 * a record that merely has an object field named `data` keeps its top level. When the record
 * lacks its identity, the envelope's identity (or `id`) is the one the create answered.
 */
export function createdRecordOf(response: unknown, identity: string, sent: unknown): Record_ {
	if (!isPlainRecord(response)) return {}
	const submitted = isPlainRecord(sent)
		? Object.entries(sent).filter(([, value]) => isScalarId(value) || typeof value === "boolean")
		: []
	const holds = (candidate: Record_): number => submitted.filter(([key, value]) => candidate[key] === value).length
	let record = response
	for (const key of CREATE_ENVELOPE_KEYS) {
		const inner = response[key]
		if (isPlainRecord(inner) && holds(inner) > holds(record)) record = inner
	}
	if (record === response || isScalarId(record[identity])) return record
	const answered = isScalarId(response[identity]) ? response[identity] : response.id
	return isScalarId(answered) ? { ...record, [identity]: answered } : record
}

/** Where an operation's answer declares the created id and the record (`x-entity`). */
export interface CreatedIdSource {
	createdIdFrom: string | null
	recordPath: string | null
}

/** A created id as the answer carried it, and whether the answer names it by contract. */
export interface CreatedId {
	id: ProvenId
	/** The value as answered, number or string, for the record oat keeps. */
	value: string | number
	trusted: boolean
}

function asCreatedId(value: unknown, trusted: boolean): CreatedId | undefined {
	const id = createdId(value)
	return id === undefined || !isScalarId(value) ? undefined : { id, trusted, value }
}

/** The created record's id: declared, then the answer's own identity, then candidates. */
export function resolveCreatedId(input: {
	body: unknown
	entity: string
	identity: string
	sent: unknown
	source: CreatedIdSource
}): CreatedId | undefined {
	const { body, identity, source } = input
	if (source.createdIdFrom !== null) {
		const declared = asCreatedId(readPath(body, source.createdIdFrom), true)
		if (declared !== undefined) return declared
	}
	if (isPlainRecord(body)) {
		const own = asCreatedId(body[identity], true)
		if (own !== undefined) return own
	}
	if (source.recordPath !== null) {
		const record = readPath(body, source.recordPath)
		const inRecord = isPlainRecord(record) ? asCreatedId(record[identity], false) : undefined
		if (inRecord !== undefined) return inRecord
	}
	return (
		asCreatedId(createdRecordOf(body, identity, input.sent)[identity], false) ??
		asCreatedId(findCreatedId(body, createdIdKeys(input.entity, identity)), false)
	)
}
