/** Schema algebra: what a schema admits at a glance, and `allOf` folded into one schema. */

import type { JsonSchema } from "../../spec/types.ts"
import { Unconstructible } from "./unconstructible.ts"

export function isObject(value: unknown): value is JsonSchema {
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

/**
 * Folds `base`'s `allOf` branches into one schema: properties merged, bounds intersected, every pattern kept. `pointer` is the
 * value being generated, `path` the `allOf` within its schema; one that is not a list of schemas
 * admits nothing anyone could construct.
 */
export function mergeAll(base: JsonSchema, pointer: string, path = "allOf"): JsonSchema {
	const branches = base.allOf
	if (!Array.isArray(branches)) throw new Unconstructible(`${path} is not a list of schemas`, pointer)
	let out: JsonSchema = { ...base }
	delete out.allOf
	for (const [index, branch] of branches.entries()) {
		if (!isObject(branch)) continue
		const nested = branch.allOf === undefined ? branch : mergeAll(branch, pointer, `${path}/${index}/allOf`)
		out = merge(out, nested)
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
	properties: (existing, value) => ({ ...(existing as JsonSchema), ...(value as JsonSchema) }),
	required: (existing, value) => [...new Set([...(existing as string[]), ...(value as string[])])],
	type: bothTypes,
}

/* Two patterns both hold, and one schema object holds one `pattern`: a second one is carried as an `allOf` branch. */
function withPattern(out: JsonSchema, pattern: unknown): void {
	const residual = Array.isArray(out.allOf) ? (out.allOf as unknown[]) : []
	if (out.pattern === pattern || residual.some((branch) => isObject(branch) && branch.pattern === pattern)) return
	out.allOf = [...residual, { pattern }]
}

export function merge(a: JsonSchema, b: JsonSchema): JsonSchema {
	const out: JsonSchema = { ...a }
	for (const [key, value] of Object.entries(b)) {
		const existing = out[key]
		if (existing === undefined) {
			out[key] = value
			continue
		}
		if (key === "pattern") withPattern(out, value)
		else if (key === "allOf" && Array.isArray(existing) && Array.isArray(value)) out.allOf = [...existing, ...value]
		else if (Object.hasOwn(COMBINE, key)) out[key] = (COMBINE[key] as Combine)(existing, value)
		else out[key] = isObject(existing) && isObject(value) ? merge(existing, value) : value
	}
	return out
}

export function typesOf(schema: JsonSchema): string[] {
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
