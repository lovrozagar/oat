/**
 * Values from schemas — the one place oat invents data.
 *
 * Seeding a cohort and probing a check both need values: a record to create, a second value to
 * patch to, an identifier that is well-formed and absent, a value just outside an enum. They used
 * to be invented in two places plus a dozen string literals in the checks (`"oat patched value"`,
 * `"<id>-oat-absent"`), and the literals were wrong exactly where it mattered: not a UUID where the
 * API takes UUIDs, not a date where it takes dates. Everything comes from here now, from the
 * normalized schema (see `spec/schema.ts`), and anything that cannot be constructed says so rather
 * than sending something the document forbids.
 *
 * Generation is deterministic in its inputs. Distinctness across runs comes from a per-run nonce,
 * never from suffix arithmetic that ignores `maximum`, `multipleOf`, `enum` or `format`.
 */

import { DEFS_ID } from "../spec/load.ts"
import { UNICODE_COHORT_STRING, codePointCount, sliceCodePoints } from "./payloads.ts"

type Schema = Record<string, unknown>

export type Variant =
	| "baseline"
	| "lexical-first"
	| "lexical-last"
	| "null-heavy"
	| "unicode"
	| "metacharacter"
	| "boundary"

export interface GenerateOptions {
	variant?: Variant
	/** Position in a cohort. Different indexes give different values wherever the schema allows. */
	index?: number
	rand?: () => number
	/** Recursive schemas a document refers to as `oat-defs#/$defs/<name>`. */
	defs?: Record<string, Schema>
	/** Per-run token mixed into values that must not collide with an earlier run's. */
	nonce?: string
	/** Property names, at the top level, whose values must be distinct across runs too. */
	distinct?: ReadonlySet<string>
	/** Optional properties to leave out. A cohort sends them; a probe built on top need not. */
	optional?: "all" | "none"
}

export type Generated = { ok: true; value: unknown } | { ok: false; reason: string; pointer: string }

const STRINGS: Record<Variant, string> = {
	baseline: "Quarterly Report",
	boundary: "",
	"lexical-first": "aaa first alphabetically",
	"lexical-last": "zzz last alphabetically",
	metacharacter: "100% _off_ *everything*",
	"null-heavy": "null heavy record",
	unicode: UNICODE_COHORT_STRING,
}

/** How many times one recursive schema may nest inside itself before generation stops descending. */
const RECURSION_BOUND = 2
const MAX_DEPTH = 12

interface Context {
	variant: Variant
	index: number
	rand: () => number
	defs: Record<string, Schema>
	nonce: string | undefined
	distinct: ReadonlySet<string>
	optional: "all" | "none"
	refs: string[]
	depth: number
}

class Unconstructible extends Error {
	constructor(
		readonly reason: string,
		readonly pointer: string,
	) {
		super(reason)
	}
}

/** One value valid for `schema`, or why none can be made. */
export function generate(schema: unknown, options: GenerateOptions = {}): Generated {
	const ctx: Context = {
		defs: options.defs ?? {},
		depth: 0,
		distinct: options.distinct ?? new Set(),
		index: options.index ?? 0,
		nonce: options.nonce,
		optional: options.optional ?? "all",
		rand: options.rand ?? (() => 0.5),
		refs: [],
		variant: options.variant ?? "baseline",
	}
	try {
		return { ok: true, value: instance(schema, ctx, "", false) }
	} catch (error) {
		if (error instanceof Unconstructible) return { ok: false, pointer: error.pointer || "/", reason: error.reason }
		if (error instanceof RangeError)
			return { ok: false, pointer: "/", reason: "the schema nests too deeply to generate" }
		throw error
	}
}

/* ------------------------------------------------------------------ schema algebra */

function isObject(value: unknown): value is Schema {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

const ANNOTATIONS = new Set([
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
function mergeAll(base: Schema, branches: unknown[]): Schema {
	let out: Schema = { ...base }
	delete out.allOf
	for (const branch of branches) {
		if (!isObject(branch)) continue
		out = merge(out, branch.allOf === undefined ? branch : mergeAll(branch, branch.allOf as unknown[]))
	}
	return out
}

function merge(a: Schema, b: Schema): Schema {
	const out: Schema = { ...a }
	for (const [key, value] of Object.entries(b)) {
		const existing = out[key]
		if (existing === undefined) {
			out[key] = value
			continue
		}
		switch (key) {
			case "properties":
				out.properties = { ...(existing as Schema), ...(value as Schema) }
				break
			case "required":
				out.required = [...new Set([...(existing as string[]), ...(value as string[])])]
				break
			case "minimum":
			case "exclusiveMinimum":
			case "minLength":
			case "minItems":
				out[key] = Math.max(Number(existing), Number(value))
				break
			case "maximum":
			case "exclusiveMaximum":
			case "maxLength":
			case "maxItems":
				out[key] = Math.min(Number(existing), Number(value))
				break
			case "enum":
				out.enum = (existing as unknown[]).filter((item) =>
					(value as unknown[]).some((other) => JSON.stringify(other) === JSON.stringify(item)),
				)
				break
			case "type": {
				const left = Array.isArray(existing) ? existing : [existing]
				const right = Array.isArray(value) ? value : [value]
				const both = left.filter((type) => right.includes(type) || (type === "integer" && right.includes("number")))
				out.type = both.length === 1 ? both[0] : both
				break
			}
			default:
				out[key] = isObject(existing) && isObject(value) ? merge(existing, value) : value
		}
	}
	return out
}

function typesOf(schema: Schema): string[] {
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

/* ------------------------------------------------------------------ the walk */

function instance(raw: unknown, ctx: Context, pointer: string, distinct: boolean): unknown {
	if (ctx.depth > MAX_DEPTH) throw new Unconstructible("the schema nests too deeply to generate", pointer)
	if (raw === false) throw new Unconstructible("the schema admits no value (false)", pointer)
	if (raw === true || isVacuous(raw)) return text(ctx, distinct)
	if (!isObject(raw)) throw new Unconstructible("the schema is not an object", pointer)
	let schema: Schema = raw

	const ref = schema.$ref
	if (typeof ref === "string") {
		const name = ref.startsWith(`${DEFS_ID}#/$defs/`) ? ref.slice(`${DEFS_ID}#/$defs/`.length) : undefined
		const target = name === undefined ? undefined : ctx.defs[name]
		if (name === undefined || target === undefined) {
			throw new Unconstructible(`cannot follow ${ref}`, pointer)
		}
		if (ctx.refs.filter((seen) => seen === name).length >= RECURSION_BOUND) {
			throw new Unconstructible(`recursion through ${name} is bounded at depth ${RECURSION_BOUND}`, pointer)
		}
		const { $ref: _ref, ...siblings } = schema
		const inner = { ...ctx, refs: [...ctx.refs, name] }
		return instance(Object.keys(siblings).length === 0 ? target : merge(target, siblings), inner, pointer, distinct)
	}

	if (Array.isArray(schema.allOf)) schema = mergeAll(schema, schema.allOf)
	if ("const" in schema) return schema.const

	/* A union keeps its base: `{properties: {kind}, oneOf: [...]}` needs `kind` whichever branch. */
	const union = (schema.oneOf ?? schema.anyOf) as unknown[] | undefined
	if (Array.isArray(union) && union.length > 0) {
		const { oneOf: _o, anyOf: _a, ...base } = schema
		const isNull = (branch: unknown): boolean => isObject(branch) && branch.type === "null"
		if (ctx.variant === "null-heavy" && union.some(isNull)) return null
		const failures: string[] = []
		for (const branch of union.filter((candidate) => !isNull(candidate))) {
			const candidate = isObject(branch) ? merge(base, branch) : branch
			try {
				return instance(candidate, ctx, pointer, distinct)
			} catch (error) {
				if (!(error instanceof Unconstructible)) throw error
				failures.push(error.reason)
			}
		}
		if (union.some(isNull)) return null
		throw new Unconstructible(`no branch of the union can be generated: ${failures.join("; ")}`, pointer)
	}

	if (Array.isArray(schema.enum)) {
		const options = schema.enum.filter((item) => item !== null)
		if (ctx.variant === "null-heavy" && schema.enum.includes(null)) return null
		if (options.length === 0) {
			if (schema.enum.includes(null)) return null
			throw new Unconstructible("the enum is empty", pointer)
		}
		return options[ctx.index % options.length]
	}

	const types = typesOf(schema)
	if (ctx.variant === "null-heavy" && types.includes("null")) return null
	const type = types.find((item) => item !== "null")
	if (type === undefined) return null

	const next = { ...ctx, depth: ctx.depth + 1 }
	switch (type) {
		case "string":
			return stringFor(schema, ctx, pointer, distinct)
		case "integer":
		case "number":
			return numberFor(schema, ctx, pointer, type === "integer", distinct)
		case "boolean":
			return ctx.index % 2 === 0
		case "array":
			return arrayFor(schema, next, pointer)
		case "object":
			return objectFor(schema, next, pointer)
		default:
			throw new Unconstructible(`unknown type "${type}"`, pointer)
	}
}

function objectFor(schema: Schema, ctx: Context, pointer: string): Record<string, unknown> {
	const properties = isObject(schema.properties) ? schema.properties : {}
	const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
	const out: Record<string, unknown> = {}
	for (const [name, sub] of Object.entries(properties)) {
		if (!required.has(name) && ctx.optional === "none") continue
		const child = `${pointer}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`
		const distinct = pointer === "" && ctx.distinct.has(name)
		try {
			out[name] = instance(sub, ctx, child, distinct)
		} catch (error) {
			/* An optional property that cannot be made is left out; a required one cannot be. */
			if (!(error instanceof Unconstructible) || required.has(name)) throw error
		}
	}
	for (const name of required) {
		if (Object.hasOwn(out, name)) continue
		/* Required but undescribed: any value satisfies the schema. */
		out[name] = text(ctx, false)
	}
	return out
}

function arrayFor(schema: Schema, ctx: Context, pointer: string): unknown[] {
	const min = typeof schema.minItems === "number" ? schema.minItems : 0
	const max = typeof schema.maxItems === "number" ? schema.maxItems : Number.POSITIVE_INFINITY
	if (min > max) throw new Unconstructible(`minItems ${min} exceeds maxItems ${max}`, pointer)
	const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : []
	const out: unknown[] = prefix.map((item, position) =>
		instance(item, { ...ctx, index: ctx.index + position }, `${pointer}/${position}`, false),
	)
	/* One element where the schema allows it: an empty array fails `minItems` on exactly the
	 * collections most worth testing, and one element is what a cohort needs to filter on. */
	const want = Math.min(Math.max(min, prefix.length, 1), max)
	const items = schema.items
	if (items === false || out.length >= want) return out
	const seen = new Set(out.map((value) => JSON.stringify(value)))
	for (let attempt = 0; out.length < want && attempt < want + 8; attempt++) {
		let value: unknown
		try {
			value = instance(items ?? true, { ...ctx, index: ctx.index + attempt }, `${pointer}/${out.length}`, false)
		} catch (error) {
			if (error instanceof Unconstructible && out.length >= min) break
			throw error
		}
		const key = JSON.stringify(value)
		if (schema.uniqueItems === true && seen.has(key)) continue
		seen.add(key)
		out.push(value)
	}
	if (out.length < min) throw new Unconstructible(`cannot make ${min} distinct items`, pointer)
	return out
}

/* ------------------------------------------------------------------ scalars */

function slug(variant: Variant): string {
	return variant.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
}

function text(ctx: Context, distinct: boolean): string {
	const base = `${STRINGS[ctx.variant]} ${ctx.index}`
	return distinct && ctx.nonce !== undefined ? `${base} ${ctx.nonce}` : base
}

/** A deterministic v4-shaped UUID from a salt. */
export function uuidFrom(salt: string): string {
	let h = 0x811c9dc5
	const hex: string[] = []
	for (let round = 0; hex.join("").length < 32; round++) {
		for (const ch of `${salt}:${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
		hex.push(h.toString(16).padStart(8, "0"))
	}
	const s = hex.join("").slice(0, 32)
	const variant = "89ab"[Number.parseInt(s[16] ?? "0", 16) % 4]
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${variant}${s.slice(17, 20)}-${s.slice(20, 32)}`
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0")
}

/** A value for each `format` oat knows; `undefined` for one it does not. */
function formatted(format: string, ctx: Context, distinct: boolean): string | undefined {
	const i = ctx.index
	const salt = `${ctx.variant}:${i}${distinct ? `:${ctx.nonce ?? ""}` : ""}`
	const first = ctx.variant === "lexical-first" || ctx.variant === "boundary"
	const last = ctx.variant === "lexical-last"
	const year = first ? 2000 : last ? 2099 : 2024
	const month = first ? 1 : last ? 12 : (i % 12) + 1
	const day = first ? 1 : last ? 28 : (i % 28) + 1
	const minute = (i * 7) % 60
	switch (format) {
		case "date":
			return `${year}-${pad(month)}-${pad(day)}`
		case "date-time":
			return `${year}-${pad(month)}-${pad(day)}T${pad(10 + (i % 12))}:${pad(minute)}:00Z`
		case "time":
			return `${pad(10 + (i % 12))}:${pad(minute)}:00Z`
		case "uuid":
			return uuidFrom(salt)
		case "email":
		case "idn-email":
			return `oat-${slug(ctx.variant)}-${i}${distinct && ctx.nonce !== undefined ? `-${ctx.nonce}` : ""}@example.test`
		case "uri":
		case "url":
		case "iri":
		case "uri-reference":
		case "iri-reference":
			return `https://example.test/${slug(ctx.variant)}-${i}${distinct && ctx.nonce !== undefined ? `-${ctx.nonce}` : ""}`
		case "hostname":
		case "idn-hostname":
			return `host-${i}${distinct && ctx.nonce !== undefined ? `-${ctx.nonce}` : ""}.example.test`
		case "ipv4":
			return `192.0.2.${(i % 250) + 1}`
		case "ipv6":
			return `2001:db8::${(i % 250) + 1}`
		case "byte":
			return Buffer.from(`oat ${i}`).toString("base64")
		default:
			return undefined
	}
}

function stringFor(schema: Schema, ctx: Context, pointer: string, distinct: boolean): string {
	const min = typeof schema.minLength === "number" ? schema.minLength : 0
	const max = typeof schema.maxLength === "number" ? schema.maxLength : Number.POSITIVE_INFINITY
	if (min > max) throw new Unconstructible(`minLength ${min} exceeds maxLength ${max}`, pointer)
	const format = typeof schema.format === "string" ? schema.format.toLowerCase() : undefined
	const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined

	const unpadded = format === undefined ? undefined : formatted(format, ctx, distinct)
	/* A short address or URL can be lengthened without leaving its format; a date cannot. */
	const known = unpadded === undefined ? undefined : padFormatted(format as string, unpadded, min)
	if (known !== undefined) {
		if (codePointCount(known) > max || codePointCount(known) < min) {
			throw new Unconstructible(`a ${format} cannot fit length ${min}–${max}`, pointer)
		}
		if (pattern !== undefined && !matches(pattern, known)) {
			throw new Unconstructible(`a ${format} cannot match pattern ${pattern}`, pointer)
		}
		return known
	}
	if (pattern !== undefined) {
		const candidate = matching(pattern, min, max, ctx, distinct)
		if (candidate === undefined) throw new Unconstructible(`no string found for pattern ${pattern}`, pointer)
		return candidate
	}

	let value = ctx.variant === "boundary" ? "B".repeat(Math.max(1, Math.min(max, 512))) : text(ctx, distinct)
	if (codePointCount(value) > max) {
		/* Keep the distinguishing tail when shortening: the index and nonce are what make it unique. */
		const tail = distinct && ctx.nonce !== undefined ? ` ${ctx.nonce}` : ` ${ctx.index}`
		value =
			codePointCount(tail) < max
				? sliceCodePoints(value, max - codePointCount(tail)) + tail
				: sliceCodePoints(value, max)
	}
	if (codePointCount(value) < min) value = value + "x".repeat(min - codePointCount(value))
	return value
}

function padFormatted(format: string, value: string, min: number): string {
	const short = min - codePointCount(value)
	if (short <= 0) return value
	if (format === "email" || format === "idn-email") return value.replace("@", `${"x".repeat(short)}@`)
	if (format.startsWith("uri") || format.startsWith("iri") || format === "url") return `${value}${"x".repeat(short)}`
	if (format === "hostname" || format === "idn-hostname") return `${"x".repeat(Math.min(short, 60))}${value}`
	return value
}

function matches(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern, "u").test(value)
	} catch {
		return false
	}
}

/** A bounded search for a string the documented pattern accepts. */
function matching(pattern: string, min: number, max: number, ctx: Context, distinct: boolean): string | undefined {
	const suffix = distinct && ctx.nonce !== undefined ? ctx.nonce : String(ctx.index)
	const fromPattern = expand(pattern, ctx.index)
	const candidates = [
		fromPattern === undefined ? undefined : `${fromPattern}${suffix}`,
		fromPattern,
		`oat${suffix}`,
		`a${suffix}`,
		suffix,
		`oat-${suffix}`,
		`oat_${suffix}`,
		`OAT${suffix}`,
		"a",
		"abc",
		`oat-${slug(ctx.variant)}-${suffix}@example.test`,
		`https://example.test/${suffix}`,
		uuidFrom(`${ctx.variant}:${suffix}`),
	]
	for (const candidate of candidates) {
		if (candidate === undefined) continue
		for (const sized of [candidate, candidate.slice(0, max), candidate.padEnd(min, candidate.at(-1) ?? "a")]) {
			const n = codePointCount(sized)
			if (n >= min && n <= max && matches(pattern, sized)) return sized
		}
	}
	return undefined
}

/** Expands the common regex subset — classes, escapes, quantifiers, groups — to one example. */
function expand(pattern: string, index: number): string | undefined {
	let source = pattern.replace(/^\^/, "").replace(/\$$/, "")
	let out = ""
	const quantity = (): number => {
		const q = source[0]
		if (q === "+" || q === "*" || q === "?") {
			source = source.slice(1)
			return q === "+" ? 2 : q === "*" ? 1 : 1
		}
		const braces = /^\{(\d+)(,(\d*))?\}/.exec(source)
		if (braces !== null) {
			source = source.slice(braces[0].length)
			return Number(braces[1])
		}
		return 1
	}
	let guard = 0
	while (source.length > 0 && guard++ < 512) {
		const ch = source[0] as string
		let atom: string
		if (ch === "[") {
			const close = source.indexOf("]", 1)
			if (close < 0) return undefined
			const body = source.slice(1, close).replace(/^\^/, "")
			atom = body.startsWith("\\d") ? String(index % 10) : body.startsWith("\\w") ? "a" : (body[0] ?? "a")
			if (body[1] === "-" && body[2] !== undefined) atom = body[0] ?? "a"
			source = source.slice(close + 1)
		} else if (ch === "\\") {
			const next = source[1] ?? ""
			atom = next === "d" ? String(index % 10) : next === "w" ? "a" : next === "s" ? " " : next
			source = source.slice(2)
		} else if (ch === "(") {
			const close = source.indexOf(")")
			if (close < 0) return undefined
			const inner = source.slice(1, close).replace(/^\?:/, "").split("|")[0] ?? ""
			atom = expand(inner, index) ?? ""
			source = source.slice(close + 1)
		} else if (ch === ".") {
			atom = "a"
			source = source.slice(1)
		} else if (ch === "|" || ch === ")") {
			break
		} else {
			atom = ch
			source = source.slice(1)
		}
		out += atom.repeat(quantity())
	}
	return out
}

function numberFor(schema: Schema, ctx: Context, pointer: string, integer: boolean, distinct: boolean): number {
	const step = typeof schema.multipleOf === "number" && schema.multipleOf > 0 ? schema.multipleOf : integer ? 1 : 0
	const exclusiveLo = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined
	const exclusiveHi = typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined
	const lo = Math.max(
		typeof schema.minimum === "number" ? schema.minimum : Number.NEGATIVE_INFINITY,
		exclusiveLo ?? Number.NEGATIVE_INFINITY,
	)
	const hi = Math.min(
		typeof schema.maximum === "number" ? schema.maximum : Number.POSITIVE_INFINITY,
		exclusiveHi ?? Number.POSITIVE_INFINITY,
	)
	const admits = (value: number): boolean =>
		value >= lo &&
		value <= hi &&
		(exclusiveLo === undefined || value > exclusiveLo) &&
		(exclusiveHi === undefined || value < exclusiveHi) &&
		(!integer || Number.isInteger(value)) &&
		(step === 0 || Math.abs(value / step - Math.round(value / step)) < 1e-9)
	const snap = (value: number, direction: "up" | "down"): number => {
		if (step === 0) return value
		const units = direction === "up" ? Math.ceil(value / step - 1e-9) : Math.floor(value / step + 1e-9)
		return Number((units * step).toFixed(10))
	}

	/* A ladder whose lexical order differs from its numeric order (1, 10, 100, 2, 20, 5, 50 as
	 * text), so a backend comparing numbers as strings is visibly wrong. */
	const ladder = [1, 2, 5, 10, 20, 50, 100]
	const rung = ladder[ctx.index % ladder.length] ?? 1
	const origin = Number.isFinite(lo) ? lo : 0
	const fraction = integer ? 0 : Math.round(ctx.rand() * 9) / 10
	const offset = distinct && ctx.nonce !== undefined ? nonceNumber(ctx.nonce) % 997 : 0
	const preferred =
		ctx.variant === "boundary" && Number.isFinite(hi)
			? hi
			: ctx.variant === "boundary" && Number.isFinite(lo)
				? lo
				: origin + rung + fraction + offset * Math.max(step, 1)

	const candidates = [
		snap(Math.min(Math.max(preferred, lo), hi), "up"),
		snap(Math.min(Math.max(preferred, lo), hi), "down"),
		snap(lo, "up"),
		snap(hi, "down"),
		snap((Number.isFinite(lo) ? lo : 0) + (Number.isFinite(hi) ? (hi - (Number.isFinite(lo) ? lo : 0)) / 2 : 1), "up"),
	]
	for (const candidate of candidates) {
		if (Number.isFinite(candidate) && admits(candidate)) return candidate
		if (Number.isFinite(candidate) && admits(candidate + (step || (integer ? 1 : 0.5)))) {
			return candidate + (step || (integer ? 1 : 0.5))
		}
	}
	throw new Unconstructible(`no ${integer ? "integer" : "number"} satisfies the bounds`, pointer)
}

function nonceNumber(nonce: string): number {
	let h = 0
	for (const ch of nonce) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
	return h
}

/* ------------------------------------------------------------------ intents */

/** A valid value that differs from `other` — the value a write probe changes a field to. */
export function distinctValue(schema: unknown, other: unknown, options: GenerateOptions = {}): Generated {
	const base = options.index ?? 0
	for (let index = base + 1; index < base + 12; index++) {
		const result = generate(schema, { ...options, index })
		if (!result.ok) return result
		if (JSON.stringify(result.value) !== JSON.stringify(other)) return result
	}
	return { ok: false, pointer: "/", reason: "the schema admits no value different from the current one" }
}

/**
 * An identifier that is well-formed for `schema` and names nothing: a UUID where the API takes
 * UUIDs, an integer where it takes integers. Comparing a malformed probe against a real one
 * compares a 400 with a 404 and reads the difference as a leak.
 */
export function absentIdentifier(schema: unknown, nonce: string): Generated {
	const s = isObject(schema) ? schema : {}
	const types = typesOf(s)
	if (types.includes("integer") || types.includes("number")) {
		const hi = typeof s.maximum === "number" ? s.maximum : 2_147_483_647
		const value = Math.max(typeof s.minimum === "number" ? s.minimum : 1, hi - (nonceNumber(nonce) % 1000))
		return { ok: true, value: Number.isInteger(value) ? value : Math.floor(value) }
	}
	const format = typeof s.format === "string" ? s.format : undefined
	if (format === "uuid") return { ok: true, value: uuidFrom(`absent:${nonce}`) }
	return generate({ ...s, format }, { distinct: new Set(), index: 9001, nonce })
}

/** A value of the right type outside the declared enum, or why there is none. */
export function outsideEnum(schema: unknown): Generated {
	if (!isObject(schema) || !Array.isArray(schema.enum)) return { ok: false, pointer: "/", reason: "no enum declared" }
	const values = schema.enum
	if (values.every((value) => typeof value === "number")) {
		return { ok: true, value: Math.max(...(values as number[])) + 1 }
	}
	let candidate = "oat-not-in-enum"
	while (values.includes(candidate)) candidate = `${candidate}-x`
	return { ok: true, value: candidate }
}

/** A string one character longer than `maxLength` allows, or why there is none. */
export function overMaxLength(schema: unknown): Generated {
	if (!isObject(schema) || typeof schema.maxLength !== "number") {
		return { ok: false, pointer: "/", reason: "no maxLength declared" }
	}
	return { ok: true, value: "x".repeat(schema.maxLength + 1) }
}

/**
 * A value of the field's own type that no record is likely to hold — the probe for "is this
 * declared filter accepted at all". A string where the field is a string, a number where it is one.
 */
export function filterSentinel(schema: unknown, nonce: string): Generated {
	const s = isObject(schema) ? schema : {}
	if (Array.isArray(s.enum) && s.enum.length > 0) return { ok: true, value: s.enum.at(-1) }
	const types = typesOf(s)
	if (types.includes("boolean")) return { ok: true, value: true }
	if (types.includes("integer") || types.includes("number")) return absentIdentifier(s, nonce)
	const wrapped = generate(
		{ properties: { value: s }, required: ["value"], type: "object" },
		{ distinct: new Set(["value"]), index: 4242, nonce, variant: "lexical-last" },
	)
	return wrapped.ok ? { ok: true, value: (wrapped.value as Record<string, unknown>).value } : wrapped
}
