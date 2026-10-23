/**
 * `x-privileged: true` on a request body property: only the highest-rank principal may set it, as a
 * plan or a verified flag. A write by anyone else that includes it must be refused or leave it
 * unchanged. The marker goes on a schema property, by overlay when the document lacks it, and is a
 * boolean; anywhere else, or of any other type, it is a gap and oat ignores it.
 */

import type { OperationObject, JsonSchema } from "../types.ts"
import type { GapCollector } from "./gaps.ts"

/** The marker's name. */
export const PRIVILEGED = "x-privileged"

const TAG = PRIVILEGED

/** Where the marker is read from: the operation's request body, and where its gaps go. */
export interface PrivilegedSource {
	body: JsonSchema | null
	operationId: string
	gaps: GapCollector
}

/** The request body properties marked privileged, nested ones by dotted path, in schema order. */
export function readPrivileged(op: OperationObject, source: PrivilegedSource): string[] {
	const { body, gaps, operationId } = source
	const misplaced = (where: string): void =>
		gaps.record(operationId, TAG, `${TAG} belongs on a request body property, not on ${where}; oat cannot use it`)
	if ((op as Record<string, unknown>)[TAG] !== undefined) misplaced("the operation")
	if (body === null) return []
	if (body[TAG] !== undefined) misplaced("the body itself")
	const marked: string[] = []
	walk(body, { gaps, marked, operationId, prefix: "", seen: new Set() })
	return marked
}

/**
 * The marked properties (`readPrivileged`'s paths) the body requires: each segment of the path is
 * required where it sits, by the object or one of its allOf members. Only the highest rank can send
 * a create whose body requires one.
 */
export function requiredPrivileged(body: JsonSchema | null, marked: readonly string[]): string[] {
	return marked.filter((path) => {
		let at: JsonSchema | undefined = body ?? undefined
		for (const name of path.split(".")) {
			if (at === undefined || !requiredAt(at).includes(name)) return false
			at = propertyAt(at, name)
		}
		return true
	})
}

/* The names an object schema requires, its allOf members' included. */
function requiredAt(schema: JsonSchema): unknown[] {
	return [schema, ...schemas(schema.allOf)].flatMap((part) => (Array.isArray(part.required) ? part.required : []))
}

/* The schema of property `name`, declared by the object or one of its allOf members. */
function propertyAt(schema: JsonSchema, name: string): JsonSchema | undefined {
	return [schema, ...schemas(schema.allOf)].map((part) => schemaMap(part.properties)[name]).find(isSchema)
}

interface Walk {
	gaps: GapCollector
	operationId: string
	marked: string[]
	prefix: string
	seen: Set<JsonSchema>
}

/* Each property of `schema` and of its allOf members, then each nested object's. */
function walk(schema: JsonSchema, at: Walk): void {
	if (at.seen.has(schema)) return
	at.seen.add(schema)
	for (const member of schemas(schema.allOf)) walk(member, at)
	for (const [name, property] of Object.entries(schemaMap(schema.properties))) {
		const path = `${at.prefix}${name}`
		const marker = property[TAG]
		if (marker === true) at.marked.push(path)
		else if (marker !== undefined && marker !== false) {
			at.gaps.record(at.operationId, TAG, `${TAG} on property "${path}" must be true or false; oat cannot use it`)
		}
		walk(property, { ...at, prefix: `${path}.` })
	}
}

function isSchema(value: unknown): value is JsonSchema {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function schemas(value: unknown): JsonSchema[] {
	return Array.isArray(value) ? value.filter(isSchema) : []
}

function schemaMap(value: unknown): Record<string, JsonSchema> {
	if (!isSchema(value)) return {}
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, JsonSchema] => isSchema(entry[1])))
}
