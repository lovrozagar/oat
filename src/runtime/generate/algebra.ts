/** Schema algebra: what a schema admits at a glance, and `allOf` folded into one schema. */

import type { Schema } from "./types.ts"

export function isObject(value: unknown): value is Schema {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

const ANNOTATIONS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"description",
	"title",
	"deprecated",
	"examples",
	"readOnly",
	"writeOnly",
	"default",
	"$comment",
	"$schema",
	"$id",
	"$anchor",
	"contentMediaType",
	"contentEncoding",
])

/** `{}`, `true`, or annotations alone: any value at all. */
export function isVacuous(schema: unknown): boolean {
	if (schema === true) return true
	if (!isObject(schema)) return false
	return Object.keys(schema).every((key) => ANNOTATIONS.has(key) || key.startsWith("x-"))
}

/** Folds `allOf` branches into one schema: properties merged, bounds intersected. */
export function mergeAll(base: Schema, branches: unknown[]): Schema {
	let out: Schema = { ...base }
	delete out.allOf
	for (const branch of branches) {
		if (!isObject(branch)) continue
		out = merge(out, branch.allOf === undefined ? branch : mergeAll(branch, branch.allOf as unknown[]))
	}
	return out
}

type Combine = (existing: unknown, value: unknown) => unknown

const larger: Combine = (existing, value) => Math.max(Number(existing), Number(value))
const smaller: Combine = (existing, value) => Math.min(Number(existing), Number(value))

function bothTypes(existing: unknown, value: unknown): unknown {
	const left = Array.isArray(existing) ? existing : [existing]
	const right = Array.isArray(value) ? value : [value]
	const both = left.filter((type) => right.includes(type) || (type === "integer" && right.includes("number")))
	return both.length === 1 ? both[0] : both
}

/** How a keyword both schemas set combines; any other keyword merges as a schema or is overwritten. */
const COMBINE: Readonly<Record<string, Combine>> = {
	enum: (existing, value) =>
		(existing as unknown[]).filter((item) =>
			(value as unknown[]).some((other) => JSON.stringify(other) === JSON.stringify(item)),
		),
	exclusiveMaximum: smaller,
	exclusiveMinimum: larger,
	maxItems: smaller,
	maxLength: smaller,
	maximum: smaller,
	minItems: larger,
	minLength: larger,
	minimum: larger,
	properties: (existing, value) => ({ ...(existing as Schema), ...(value as Schema) }),
	required: (existing, value) => [...new Set([...(existing as string[]), ...(value as string[])])],
	type: bothTypes,
}

export function merge(a: Schema, b: Schema): Schema {
	const out: Schema = { ...a }
	for (const [key, value] of Object.entries(b)) {
		const existing = out[key]
		if (existing === undefined) {
			out[key] = value
			continue
		}
		if (Object.hasOwn(COMBINE, key)) out[key] = (COMBINE[key] as Combine)(existing, value)
		else out[key] = isObject(existing) && isObject(value) ? merge(existing, value) : value
	}
	return out
}

export function typesOf(schema: Schema): string[] {
	const type = schema.type
	if (typeof type === "string") return [type]
	if (Array.isArray(type)) return type.filter((item): item is string => typeof item === "string")
	if (schema.properties !== undefined || schema.required !== undefined) return ["object"]
	if (schema.items !== undefined || schema.prefixItems !== undefined) return ["array"]
	if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((k) => k in schema)) {
		return ["number"]
	}
	return ["string"]
}
