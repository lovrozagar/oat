/**
 * What a string schema asks of a value, `allOf` and a nullable union folded in, and whether a value
 * meets it. The one answer generation, the self probe and the concurrency check give to "does this
 * field take this string": a guard pattern a document sets on every string costs nothing when the
 * value meets it.
 */

import { codePointCount } from "../payloads.ts"
import { isObject, merge, mergeAll } from "./algebra.ts"
import { matches } from "./pattern.ts"
import type { JsonSchema } from "../../spec/types.ts"

export interface StringConstraints {
	minLength: number
	maxLength: number
	/** Every pattern the value must match, each unanchored and compiled with the `u` flag. */
	patterns: string[]
	format?: string
	enum?: unknown[]
}

/* A union whose one branch is not `null` is that branch, with what sits beside the union. */
function nonNull(schema: JsonSchema): JsonSchema {
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
	if (branches === null) return schema
	const kept = branches.filter((branch) => isObject(branch) && branch.type !== "null")
	const only = kept.length === 1 ? kept[0] : undefined
	if (!isObject(only)) return schema
	const { anyOf: _anyOf, oneOf: _oneOf, ...beside } = schema
	return nonNull(merge(beside, only))
}

function folded(schema: JsonSchema): JsonSchema {
	const one = nonNull(schema)
	return Array.isArray(one.allOf) ? mergeAll(one, "") : one
}

export function stringConstraints(schema: JsonSchema): StringConstraints {
	const flat = folded(schema)
	const residual = Array.isArray(flat.allOf) ? flat.allOf : []
	const patterns = [flat.pattern, ...residual.filter(isObject).map((branch) => branch.pattern)]
	const out: StringConstraints = {
		maxLength: typeof flat.maxLength === "number" ? flat.maxLength : Number.POSITIVE_INFINITY,
		minLength: typeof flat.minLength === "number" ? flat.minLength : 0,
		patterns: patterns.filter((pattern): pattern is string => typeof pattern === "string"),
	}
	if (typeof flat.format === "string") out.format = flat.format
	if (Array.isArray(flat.enum)) out.enum = flat.enum
	return out
}

/** Whether `value` is within the lengths, in code points, and matches every pattern. */
export function admits(constraints: StringConstraints, value: string): boolean {
	const length = codePointCount(value)
	if (length < constraints.minLength || length > constraints.maxLength) return false
	return constraints.patterns.every((pattern) => matches(pattern, value))
}
