/**
 * Schema-driven fixture generation.
 *
 * Valid-random data cannot test a query engine: `ilike` needs a substring, `order` needs a total
 * order, escaping needs metacharacters. oat seeds a *discriminating cohort* — instances shaped so
 * that every query assertion has signal — and derives everything from a seed so a failing run is
 * exactly reproducible.
 */

export type Variant =
	| "baseline"
	| "lexical-first"
	| "lexical-last"
	| "null-heavy"
	| "unicode"
	| "metacharacter"
	| "boundary"

export const COHORT: readonly Variant[] = [
	"baseline",
	"lexical-first",
	"lexical-last",
	"null-heavy",
	"unicode",
	"metacharacter",
	"boundary",
]

/** Deterministic PRNG — same seed, same cohort, every run. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type Schema = Record<string, unknown>

const STRINGS: Record<Variant, string> = {
	baseline: "Quarterly Report",
	boundary: "",
	"lexical-first": "aaa first alphabetically",
	"lexical-last": "zzz last alphabetically",
	metacharacter: "100% _off_ *everything*",
	"null-heavy": "null heavy record",
	unicode: "日本語 café ñandú",
}

export interface CohortMember {
	variant: Variant
	body: Record<string, unknown>
}

export function buildCohort(bodySchema: Schema, seed: number, variants: readonly Variant[] = COHORT): CohortMember[] {
	return variants.map((variant, index) => ({
		body: generateObject(bodySchema, variant, mulberry32(seed + index * 7919), index),
		variant,
	}))
}

function generateObject(
	schema: Schema,
	variant: Variant,
	rand: () => number,
	index: number,
	depth = 0,
): Record<string, unknown> {
	if (depth > 4) return {}
	const properties = schema.properties
	if (properties === null || typeof properties !== "object") return {}
	const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
	const out: Record<string, unknown> = {}

	for (const [name, raw] of Object.entries(properties as Record<string, Schema>)) {
		if (raw === null || typeof raw !== "object") continue
		if (raw.readOnly === true) continue
		const value = generateValue(name, raw, variant, rand, index, depth)
		if (value === undefined) {
			if (required.includes(name)) out[name] = fallbackFor(raw)
			continue
		}
		out[name] = value
	}
	return out
}

function generateValue(
	name: string,
	schema: Schema,
	variant: Variant,
	rand: () => number,
	index: number,
	depth = 0,
): unknown {
	/* Recursive schemas are shared objects after dereferencing, so generation must be bounded. */
	if (depth > 4) return undefined
	const nullable = isNullable(schema)
	if (variant === "null-heavy" && nullable) return null

	const concrete = concreteBranch(schema)
	const type = typeOf(concrete)

	if (Array.isArray(concrete.enum) && concrete.enum.length > 0) {
		/* Walk the enum across the cohort so every value is represented and filters on it
		 * partition the set non-trivially. */
		return concrete.enum[index % concrete.enum.length]
	}

	switch (type) {
		case "string": {
			const max = typeof concrete.maxLength === "number" ? concrete.maxLength : 64
			if (variant === "boundary") return "B".repeat(Math.max(1, Math.min(max, 512)))
			const base = STRINGS[variant]
			/* Suffix keeps values distinct so equality filters select exactly one instance. */
			const text = `${base} ${index}`
			return text.length > max ? text.slice(0, max) : text
		}
		case "integer":
		case "number": {
			if (variant === "boundary" && typeof concrete.maximum === "number") return concrete.maximum
			const min = typeof concrete.minimum === "number" ? concrete.minimum : 0
			/*
			 * A ladder whose lexical order differs from its numeric order: as text these sort
			 * 1, 10, 100, 2, 20, 5, 50 — nothing like their numeric order.
			 *
			 * An evenly spaced sequence (10, 20, 30…) sorts identically either way, so a backend
			 * comparing numbers as strings would look correct. Values have to disagree for the
			 * assertion to carry any signal.
			 */
			const ladder = [1, 2, 5, 10, 20, 50, 100]
			const step = ladder[index % ladder.length] ?? 1
			return type === "integer" ? min + step : min + step + Math.round(rand() * 9) / 10
		}
		case "boolean":
			return index % 2 === 0
		case "array": {
			/* An empty array is not a safe default: `minItems` is common on required collections
			 * (column definitions, line items), and sending [] fails validation on exactly the
			 * endpoints most worth testing. */
			const min = typeof concrete.minItems === "number" ? concrete.minItems : 0
			const count = Math.max(min, 1)
			const items = concrete.items
			if (items === null || typeof items !== "object") return []
			return Array.from({ length: count }, (_, position) =>
				generateValue(`${name}_item`, items as Schema, variant, rand, index + position, depth + 1),
			)
		}
		case "object":
			return generateObject(concrete, variant, rand, index, depth + 1)
		default:
			return undefined
	}
}

function fallbackFor(schema: Schema): unknown {
	switch (typeOf(concreteBranch(schema))) {
		case "integer":
		case "number":
			return 0
		case "boolean":
			return false
		case "array":
			return []
		case "object":
			return {}
		default:
			return "value"
	}
}

/** `oneOf: [{type: string}, {type: null}]` is the nullable idiom; pick the non-null branch. */
function concreteBranch(schema: Schema): Schema {
	const union = schema.oneOf ?? schema.anyOf
	if (!Array.isArray(union)) return schema
	const branch = union.find(
		(candidate) => candidate !== null && typeof candidate === "object" && (candidate as Schema).type !== "null",
	)
	return (branch as Schema | undefined) ?? schema
}

function isNullable(schema: Schema): boolean {
	if (schema.nullable === true) return true
	const type = schema.type
	if (Array.isArray(type)) return type.includes("null")
	const union = schema.oneOf ?? schema.anyOf
	if (!Array.isArray(union)) return false
	return union.some(
		(candidate) => candidate !== null && typeof candidate === "object" && (candidate as Schema).type === "null",
	)
}

function typeOf(schema: Schema): string {
	const type = schema.type
	if (typeof type === "string") return type
	if (Array.isArray(type)) {
		const concrete = type.find((t) => t !== "null")
		if (typeof concrete === "string") return concrete
	}
	if (schema.properties !== undefined) return "object"
	if (schema.items !== undefined) return "array"
	return "string"
}
