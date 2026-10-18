/**
 * A schema as the instance sees it: `allOf` members merged into one object, and a nullable union
 * — `type: ["array", "null"]`, or `anyOf` / `oneOf` with a `null` branch — read as its one
 * non-null branch. A collection or an identity declared through either is still one.
 */

import type { SchemaObject } from "../types.ts"

export function asSchema(value: unknown): SchemaObject | null {
	return value !== null && typeof value === "object" ? (value as SchemaObject) : null
}

/** The non-null branches of the first `anyOf` / `oneOf` the schema has, when it has one. */
function nonNullBranches(schema: SchemaObject): Array<SchemaObject | null> | undefined {
	return (["anyOf", "oneOf"] as const)
		.map((key) => (Array.isArray(schema[key]) ? (schema[key] as Array<SchemaObject | null>) : null))
		.find((branches) => branches !== null)
		?.filter((branch) => branch?.type !== "null")
}

/** `type: [x, "null"]` read as `type: x`. */
function withoutNullType(schema: SchemaObject): SchemaObject {
	const types = Array.isArray(schema.type) ? (schema.type as string[]).filter((type) => type !== "null") : null
	return types !== null && types.length === 1 ? { ...schema, type: types[0] } : schema
}

function mergeAllOf(typed: SchemaObject, parts: unknown[]): SchemaObject {
	const merged: SchemaObject = { ...typed, allOf: undefined }
	for (const part of parts) {
		const member = effective(asSchema(part))
		if (member === null) continue
		merged.type ??= member.type
		merged.properties = {
			...(member.properties as Record<string, unknown> | undefined),
			...(merged.properties as Record<string, unknown> | undefined),
		}
		merged.required = [...new Set([...((merged.required as string[]) ?? []), ...((member.required as string[]) ?? [])])]
		if (merged.items === undefined && member.items !== undefined) merged.items = member.items
	}
	delete merged.allOf
	return merged
}

export function effective(schema: SchemaObject | null): SchemaObject | null {
	if (schema === null) return null
	const nonNull = nonNullBranches(schema)
	/* The one branch left is there: it is what the length counts. */
	if (nonNull !== undefined && nonNull.length === 1) return effective(nonNull[0] as SchemaObject | null)
	const typed = withoutNullType(schema)
	return Array.isArray(typed.allOf) ? mergeAllOf(typed, typed.allOf) : typed
}
