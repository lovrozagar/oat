/**
 * Schema-driven fixture generation.
 *
 * Valid-random data cannot test a query engine: `ilike` needs a substring, `order` needs a total
 * order, escaping needs metacharacters. oat seeds a *discriminating cohort* — instances shaped so
 * that every query assertion has signal — and derives everything from a seed so a failing run is
 * exactly reproducible.
 *
 * After `$ref` inlining the same object identity can cycle, and empty schemas (`{}`, `true`,
 * `additionalProperties: {}`) mean "any value", not "walk this object again". Generation therefore
 * keys a WeakSet on every node and treats those open shapes as a scalar or `{}`.
 */

import { UNICODE_COHORT_STRING, codePointCount, sliceCodePoints } from "./payloads.ts"

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
	unicode: UNICODE_COHORT_STRING,
}

const EMAIL_RE = /^[^@]+@[^@]+\.[^@]+$/
const MAX_DEPTH = 8
const PATTERN_ATTEMPTS = 48

export interface CohortMember {
	variant: Variant
	body: Record<string, unknown>
}

/** Thrown when a walk still overflows; the pointer names the node that blew the stack. */
export class FixtureOverflow extends Error {
	constructor(
		readonly operationId: string,
		readonly pointer: string,
	) {
		super(`fixture generation overflow on ${operationId} (${pointer})`)
		this.name = "FixtureOverflow"
	}
}

export function overflowFrom(error: unknown, operationId: string, pointer = "/"): FixtureOverflow {
	if (error instanceof FixtureOverflow) {
		return new FixtureOverflow(operationId, error.pointer === "/" ? pointer : error.pointer)
	}
	return new FixtureOverflow(operationId, pointer)
}

export function isOverflowError(error: unknown): boolean {
	if (error instanceof FixtureOverflow) return true
	return error instanceof RangeError
}

export function buildCohort(
	bodySchema: Schema | boolean,
	seed: number,
	variants: readonly Variant[] = COHORT,
	operationId = "unknown",
): CohortMember[] {
	try {
		return variants.map((variant, index) => ({
			body: generateObject(
				bodySchema,
				variant,
				mulberry32(seed + index * 7919),
				index,
				0,
				"/",
				new WeakSet<object>(),
				operationId,
			),
			variant,
		}))
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, operationId)
		throw error
	}
}

/**
 * One create body, or a gap if a required field cannot be honoured.
 *
 * Optional fields that cannot match `format`/`pattern` are omitted. Required ones must not fall
 * back to `"Quarterly Report N"` — that is what 400s every email/handle/url field.
 */
export function generateBody(
	bodySchema: Schema | boolean,
	variant: Variant,
	rand: () => number,
	index: number,
	operationId = "unknown",
): { body: Record<string, unknown>; missingRequired: string[] } {
	const missingRequired: string[] = []
	const body = generateObject(
		bodySchema,
		variant,
		rand,
		index,
		0,
		"/",
		new WeakSet<object>(),
		operationId,
		missingRequired,
	)
	return { body, missingRequired }
}

function generateObject(
	schema: Schema | boolean,
	variant: Variant,
	rand: () => number,
	index: number,
	depth: number,
	pointer: string,
	seen: WeakSet<object>,
	operationId: string,
	missingRequired: string[] = [],
): Record<string, unknown> {
	try {
		if (depth > MAX_DEPTH) return {}
		if (isVacuous(schema)) return {}
		if (schema === false) return {}
		if (typeof schema !== "object" || schema === null) return {}
		if (seen.has(schema)) return {}
		seen.add(schema)

		const concrete = concreteBranch(schema, depth, pointer, seen, operationId)
		if (isVacuous(concrete) || typeof concrete !== "object" || concrete === null) return {}
		if (seen.has(concrete) && concrete !== schema) return {}

		const properties = concrete.properties
		if (properties === null || typeof properties !== "object") return {}
		const required = Array.isArray(concrete.required) ? (concrete.required as string[]) : []
		const out: Record<string, unknown> = {}

		for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
			const child = `${pointer === "/" ? "" : pointer}/${escapePointer(name)}`
			const value = generateValue(name, raw, variant, rand, index, depth + 1, child, seen, operationId)
			if (value === undefined) {
				if (required.includes(name)) {
					const fallback = requiredFallback(raw, variant, index)
					if (fallback === undefined) missingRequired.push(child)
					else out[name] = fallback
				}
				continue
			}
			out[name] = value
		}
		return out
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, operationId, pointer)
		throw error
	}
}

function generateValue(
	name: string,
	raw: unknown,
	variant: Variant,
	rand: () => number,
	index: number,
	depth: number,
	pointer: string,
	seen: WeakSet<object>,
	operationId: string,
): unknown {
	try {
		if (depth > MAX_DEPTH) return undefined
		if (isVacuous(raw)) return scalarFor(name, variant, index, undefined)
		if (raw === false) return undefined
		if (typeof raw !== "object" || raw === null) return undefined
		if (seen.has(raw)) return {}

		const schema = raw as Schema
		const nullable = isNullable(schema)
		if (variant === "null-heavy" && nullable) return null
		if (schema.readOnly === true) return undefined

		const followed = followRef(schema, depth, pointer, seen, operationId)
		if (followed === "cycle") return {}
		const concrete = concreteBranch(followed === null ? schema : followed, depth, pointer, seen, operationId)
		if (isVacuous(concrete)) return scalarFor(name, variant, index, undefined)
		if (typeof concrete !== "object" || concrete === null) return scalarFor(name, variant, index, undefined)
		if (seen.has(concrete) && concrete !== schema) return {}

		if (Array.isArray(concrete.enum) && concrete.enum.length > 0) {
			return concrete.enum[index % concrete.enum.length]
		}

		const type = typeOf(concrete)

		switch (type) {
			case "string":
				return generateString(name, concrete, variant, index)
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
				const prefix = concrete.prefixItems
				if (Array.isArray(prefix)) {
					return prefix.map((item, position) =>
						generateValue(
							`${name}_${position}`,
							item,
							variant,
							rand,
							index + position,
							depth + 1,
							`${pointer}/prefixItems/${position}`,
							seen,
							operationId,
						),
					)
				}
				const items = concrete.items
				if (isVacuous(items) || items === false) return Array.from({ length: count }, () => ({}))
				if (items === null || typeof items !== "object") return []
				return Array.from({ length: count }, (_, position) =>
					generateValue(
						`${name}_item`,
						items,
						variant,
						rand,
						index + position,
						depth + 1,
						`${pointer}/items`,
						seen,
						operationId,
					),
				)
			}
			case "object":
				return generateObject(concrete, variant, rand, index, depth + 1, pointer, seen, operationId)
			default:
				return undefined
		}
	} catch (error) {
		if (isOverflowError(error)) throw overflowFrom(error, operationId, pointer)
		throw error
	}
}

function generateString(name: string, schema: Schema, variant: Variant, index: number): string | undefined {
	const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : undefined
	const minLength = typeof schema.minLength === "number" ? schema.minLength : undefined
	if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) return undefined

	const max = maxLength ?? Math.max(64, minLength ?? 0)
	const format = typeof schema.format === "string" ? schema.format.toLowerCase() : ""
	const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined

	let text: string | undefined
	if (format === "email") text = emailOf(variant, index)
	else if (format === "uri" || format === "url") text = uriOf(variant, index)
	else if (format === "uuid") text = uuidOf(variant, index)
	else if (pattern !== undefined) text = stringMatching(pattern, max, variant, index, minLength)
	else if (variant === "boundary") text = "B".repeat(Math.max(1, Math.min(max, 512)))
	else {
		const base = STRINGS[variant]
		text = `${base} ${index}`
	}

	if (text === undefined) return undefined
	if (codePointCount(text) > max) {
		if (format === "email" || format === "uri" || format === "url" || format === "uuid" || pattern !== undefined) {
			const trimmed = fitMax(text, max, format, pattern, variant, index, minLength)
			if (trimmed === undefined) return undefined
			text = trimmed
		} else {
			text = sliceCodePoints(text, max)
		}
	}
	if (minLength !== undefined && codePointCount(text) < minLength) {
		const padded = padToMin(text, minLength, max, pattern)
		if (padded !== undefined) text = padded
		else if (pattern !== undefined) text = stringMatching(pattern, max, variant, index, minLength)
		else return undefined
		if (text === undefined) return undefined
	}
	if (pattern !== undefined && !safeTest(pattern, text)) {
		return stringMatching(pattern, max, variant, index, minLength)
	}
	if (format === "email" && !EMAIL_RE.test(text)) return undefined
	void name
	return text
}

function padToMin(text: string, min: number, max: number, pattern: string | undefined): string | undefined {
	const n = codePointCount(text)
	if (n >= min) return text
	if (min > max) return undefined
	const last = n === 0 ? "a" : ([...text].at(-1) ?? "a")
	const need = min - n
	if (n + need > max) return undefined
	const padded = text + last.repeat(need)
	if (pattern !== undefined && !safeTest(pattern, padded)) return undefined
	return padded
}

function requiredFallback(raw: unknown, variant: Variant, index: number): unknown {
	if (isVacuous(raw) || raw === false || raw === null || typeof raw !== "object")
		return scalarFor("field", variant, index, undefined)
	const schema = raw as Schema
	const format = typeof schema.format === "string" ? schema.format.toLowerCase() : ""
	const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined
	if (format === "email" || format === "uri" || format === "url" || format === "uuid" || pattern !== undefined) {
		return generateString("field", schema, variant, index)
	}
	switch (typeOf(concreteBranch(schema, 0, "/", new WeakSet(), "unknown"))) {
		case "integer":
		case "number":
			return 0
		case "boolean":
			return false
		case "array":
			return []
		case "object":
			return {}
		default: {
			const generated = generateString("field", schema, variant, index)
			if (generated !== undefined) return generated
			const min = typeof schema.minLength === "number" ? schema.minLength : undefined
			const max = typeof schema.maxLength === "number" ? schema.maxLength : undefined
			if (min !== undefined && max !== undefined && min > max) return undefined
			return "value"
		}
	}
}

function emailOf(variant: Variant, index: number): string {
	const slug = slugVariant(variant)
	return `oat-${slug}-${index}@example.test`
}

function uriOf(variant: Variant, index: number): string {
	return `https://example.test/${slugVariant(variant)}-${index}`
}

function uuidOf(variant: Variant, index: number): string {
	const n = (slugVariant(variant).length * 17 + index * 7919) >>> 0
	const hex = (offset: number, width: number): string => {
		let out = ""
		let x = (n + offset * 0x9e3779b9) >>> 0
		for (let i = 0; i < width; i++) {
			out += (x & 0xf).toString(16)
			x = (Math.imul(x, 1664525) + 1013904223) >>> 0
		}
		return out
	}
	return `${hex(1, 8)}-${hex(2, 4)}-4${hex(3, 3)}-8${hex(4, 3)}-${hex(5, 12)}`
}

function slugVariant(variant: Variant): string {
	return variant
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
}

function fitMax(
	text: string,
	max: number,
	format: string,
	pattern: string | undefined,
	variant: Variant,
	index: number,
	minLength: number | undefined,
): string | undefined {
	if (format === "email") {
		const short = `o${index}@e.t`
		if (short.length <= max && EMAIL_RE.test(short)) return short
		return undefined
	}
	if (format === "uri" || format === "url") {
		const short = "https://e.t/x"
		if (short.length <= max) return short
		return undefined
	}
	if (format === "uuid") return undefined
	if (pattern !== undefined) return stringMatching(pattern, max, variant, index, minLength)
	return text.slice(0, max)
}

/** Bounded attempt at a string the documented regex will accept. */
function stringMatching(
	pattern: string,
	max: number,
	variant: Variant,
	index: number,
	minLength: number | undefined,
): string | undefined {
	const min = minLength ?? 0
	const candidates = [
		expandPattern(pattern, max, variant, index, min),
		emailOf(variant, index),
		uriOf(variant, index),
		uuidOf(variant, index),
		slugVariant(variant),
		`oat${index}`,
		`h${index}`,
		"a",
		"ab",
		"abc",
		"handle",
		`handle${index}`,
		"https://example.test/x",
		"oat@example.test",
	]
	for (const candidate of candidates) {
		if (candidate === undefined) continue
		const text = honourBounds(candidate, min, max, pattern)
		if (text !== undefined) return text
	}
	for (let attempt = 0; attempt < PATTERN_ATTEMPTS; attempt++) {
		const text = brutePattern(pattern, max, variant, index + attempt, min)
		if (text !== undefined) {
			const honoured = honourBounds(text, min, max, pattern)
			if (honoured !== undefined) return honoured
		}
	}
	return undefined
}

function honourBounds(candidate: string, min: number, max: number, pattern: string): string | undefined {
	let text = candidate.length > max ? candidate.slice(0, max) : candidate
	if (min > 0 && text.length < min) {
		const padded = padToMin(text, min, max, pattern)
		if (padded === undefined) return undefined
		text = padded
	}
	if (text.length < min || text.length > max) return undefined
	if (!safeTest(pattern, text)) return undefined
	return text
}

function safeTest(pattern: string, text: string): boolean {
	try {
		return new RegExp(pattern).test(text)
	} catch {
		return false
	}
}

/**
 * Expand a small, common subset of regexes (`[a-z0-9_]+`, `^handle$`, optional groups). Anything
 * we cannot expand is left for the candidate list — better to omit than to send a junk string.
 */
function expandPattern(pattern: string, max: number, variant: Variant, index: number, min: number): string | undefined {
	let source = pattern
	if (source.startsWith("^")) source = source.slice(1)
	if (source.endsWith("$")) source = source.slice(0, -1)
	try {
		let built = expandAtoms(source, max, variant, index)
		if (min > 0 && built.length < min) {
			const padded = padToMin(built, min, max, undefined)
			if (padded !== undefined) built = padded
		}
		if (built.length > max) return built.slice(0, max)
		return built
	} catch {
		return undefined
	}
}

function expandAtoms(source: string, max: number, variant: Variant, index: number): string {
	let i = 0
	let out = ""
	const takeQuantifier = (): { min: number; max: number } => {
		if (source[i] === "+") {
			i++
			return { max: 3, min: 1 }
		}
		if (source[i] === "*") {
			i++
			return { max: 2, min: 0 }
		}
		if (source[i] === "?") {
			i++
			return { max: 1, min: 0 }
		}
		if (source[i] === "{") {
			const close = source.indexOf("}", i)
			if (close < 0) return { max: 1, min: 1 }
			const spec = source.slice(i + 1, close)
			i = close + 1
			const [lo, hi] = spec.split(",")
			const min = Number.parseInt(lo ?? "1", 10)
			const upper = hi === undefined ? min : hi === "" ? min + 2 : Number.parseInt(hi, 10)
			if (!Number.isFinite(min) || !Number.isFinite(upper)) return { max: 1, min: 1 }
			return { max: Math.min(upper, 16), min: Math.max(0, min) }
		}
		return { max: 1, min: 1 }
	}
	const emit = (atom: string, times: number): void => {
		for (let n = 0; n < times && out.length < max; n++) out += atom
	}
	while (i < source.length && out.length < max) {
		const ch = source[i]
		if (ch === undefined) break
		if (ch === "(") {
			const close = matchingParen(source, i)
			if (close < 0) break
			const inner = source.slice(i + 1, close).replace(/^\?:/, "")
			i = close + 1
			const q = takeQuantifier()
			const piece = expandAtoms(inner.split("|")[0] ?? inner, max, variant, index)
			emit(piece, Math.max(q.min, Math.min(q.max, q.min === 0 ? 0 : 1)))
			continue
		}
		if (ch === "[") {
			const close = source.indexOf("]", i + 1)
			if (close < 0) break
			const atom = firstClassChar(source.slice(i + 1, close))
			i = close + 1
			const q = takeQuantifier()
			emit(atom, Math.max(q.min, 1))
			continue
		}
		if (ch === "\\") {
			const next = source[i + 1]
			i += 2
			const atom = next === "d" ? "0" : next === "w" ? "a" : next === "s" ? " " : (next ?? "a")
			const q = takeQuantifier()
			emit(atom, Math.max(q.min, 1))
			continue
		}
		if (ch === ".") {
			i++
			const q = takeQuantifier()
			emit("a", Math.max(q.min, 1))
			continue
		}
		if (ch === "|" || ch === ")" || ch === "^" || ch === "$") {
			i++
			continue
		}
		i++
		const q = takeQuantifier()
		emit(ch, Math.max(q.min, 1))
	}
	void variant
	void index
	return out
}

function matchingParen(source: string, start: number): number {
	let depth = 0
	for (let i = start; i < source.length; i++) {
		if (source[i] === "(") depth++
		else if (source[i] === ")") {
			depth--
			if (depth === 0) return i
		}
	}
	return -1
}

function firstClassChar(body: string): string {
	let i = 0
	if (body[0] === "^") i = 1
	while (i < body.length) {
		const ch = body[i]
		if (ch === undefined) break
		if (ch === "\\" && body[i + 1] !== undefined) {
			const next = body[i + 1]
			if (next === "d") return "0"
			if (next === "w") return "a"
			return next ?? "a"
		}
		if (body[i + 1] === "-" && body[i + 2] !== undefined) {
			return ch === "^" ? (body[i + 2] ?? "a") : ch
		}
		if (ch !== "^") return ch
		i++
	}
	return "a"
}

function brutePattern(pattern: string, max: number, variant: Variant, salt: number, min = 0): string | undefined {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_-"
	const len = Math.min(Math.max(Math.max(3, min), (salt % 8) + 3), max)
	let text = ""
	let x = (salt * 1664525 + slugVariant(variant).length) >>> 0
	for (let i = 0; i < len; i++) {
		text += alphabet[x % alphabet.length]
		x = (Math.imul(x, 22695477) + 1) >>> 0
	}
	return text
}

function scalarFor(name: string, variant: Variant, index: number, schema: Schema | undefined): string {
	if (schema !== undefined) {
		const generated = generateString(name, schema, variant, index)
		if (generated !== undefined) return generated
	}
	const base = STRINGS[variant]
	return `${base} ${index}`
}

/**
 * `{}` / `true` / a lone `additionalProperties: {}` is "any JSON", not an object to descend.
 * Walking it again is what turns `z.unknown()` into a stack overflow.
 */
export function isVacuous(schema: unknown): boolean {
	if (schema === true) return true
	if (schema === false || schema === null || typeof schema !== "object") return false
	if (Array.isArray(schema)) return false
	const keys = Object.keys(schema).filter((key) => !isAnnotation(key))
	if (keys.length === 0) return true
	if (keys.length === 1 && (keys[0] === "additionalProperties" || keys[0] === "unevaluatedProperties")) {
		return isVacuous((schema as Schema)[keys[0] as "additionalProperties"])
	}
	if (keys.length === 1 && keys[0] === "default") {
		const value = (schema as Schema).default
		return (
			value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0
		)
	}
	return false
}

function isAnnotation(key: string): boolean {
	return (
		key === "description" ||
		key === "title" ||
		key === "deprecated" ||
		key === "example" ||
		key === "examples" ||
		key === "nullable" ||
		key === "readOnly" ||
		key === "writeOnly" ||
		key === "xml" ||
		key === "externalDocs"
	)
}

/** `oneOf: [{type: string}, {type: null}]` is the nullable idiom; pick the non-null branch. */
function concreteBranch(
	schema: Schema,
	depth: number,
	pointer: string,
	seen: WeakSet<object>,
	operationId: string,
): Schema {
	if (depth > MAX_DEPTH) return {}
	const followed = followRef(schema, depth, pointer, seen, operationId)
	const base = followed === "cycle" ? {} : (followed ?? schema)
	if (typeof base !== "object" || base === null) return {}
	const union = base.oneOf ?? base.anyOf
	if (!Array.isArray(union)) return base
	const branch = union.find((candidate) => {
		if (candidate === null || typeof candidate !== "object") return candidate !== null
		return (candidate as Schema).type !== "null"
	})
	if (branch === null || typeof branch !== "object") return base
	if (seen.has(branch)) return {}
	return concreteBranch(branch as Schema, depth + 1, `${pointer}/oneOf`, seen, operationId)
}

function followRef(
	schema: Schema,
	depth: number,
	pointer: string,
	seen: WeakSet<object>,
	operationId: string,
): Schema | "cycle" | null {
	void pointer
	void operationId
	if (depth > MAX_DEPTH) return "cycle"
	const ref = schema.$ref
	if (typeof ref !== "string") return null
	/* After inlining, leftover `$ref: "#"` (or any self-ref) is the same node. Do not follow. */
	if (ref === "#" || ref === "#/" || seen.has(schema)) return "cycle"
	return "cycle"
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
	if (isVacuous(schema)) return "string"
	const add = schema.additionalProperties
	const uneval = schema.unevaluatedProperties
	if (
		schema.type === undefined &&
		schema.properties === undefined &&
		schema.items === undefined &&
		(isVacuous(add) || isVacuous(uneval))
	) {
		return "object"
	}
	const type = schema.type
	if (typeof type === "string") return type
	if (Array.isArray(type)) {
		const concrete = type.find((t) => t !== "null")
		if (typeof concrete === "string") return concrete
	}
	if (schema.properties !== undefined) return "object"
	if (schema.items !== undefined || schema.prefixItems !== undefined) return "array"
	return "string"
}

function escapePointer(name: string): string {
	return name.replace(/~/g, "~0").replace(/\//g, "~1")
}
