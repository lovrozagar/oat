/**
 * One reading of an OpenAPI schema, shared by everything that interprets one.
 *
 * The validator, the value generator and the model each used to interpret JSON Schema on their
 * own, and they disagreed: one stripped `example` anywhere it appeared — including a property
 * *named* example — another ignored `writeOnly`, a third read OpenAPI 3.0's boolean
 * `exclusiveMinimum` as a number. A schema is now translated once into JSON Schema 2020-12, for a
 * stated direction, and every consumer reads the result.
 *
 * Direction matters because OpenAPI schemas are shared between requests and responses:
 * `readOnly` properties never appear in a request and `writeOnly` ones never in a response.
 */

import { PRIVILEGED } from "./extensions/privileged.ts"
import type { SchemaObject } from "./types.ts"

export type Direction = "request" | "response"

export interface NormalizeOptions {
	direction: Direction
	/**
	 * A request as any writer may send it: an optional property marked `x-privileged`, which only the
	 * highest rank may set, is left out. A required one stays, and only the highest rank sends it.
	 */
	ordinary?: boolean
}

/** Keywords whose value is one subschema. */
const SINGLE: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedItems",
	"unevaluatedProperties",
	"not",
	"if",
	"then",
	"else",
	"contains",
	"propertyNames",
])

/** Keywords whose value is a list of subschemas. */
const LIST: ReadonlySet<string> = /* @__PURE__ */ new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

/** Keywords whose value maps names to subschemas. */
const MAP: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
])

/** OpenAPI annotations that are not JSON Schema keywords — removed from schema nodes only. */
const OPENAPI_ONLY: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"nullable",
	"example",
	"discriminator",
	"xml",
	"externalDocs",
])

/** OpenAPI 3.0 exclusive bounds are booleans qualifying `minimum` / `maximum`. */
const BOUNDS = [
	["exclusiveMinimum", "minimum"],
	["exclusiveMaximum", "maximum"],
] as const

/** One translation in progress: each source node is translated once, so a cycle stays a cycle. */
interface Normalizing {
	direction: Direction
	ordinary: boolean
	seen: Map<object, SchemaObject>
}

function isSchema(value: unknown): value is SchemaObject {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Translates `schema` into JSON Schema 2020-12 as seen in `direction`. Never mutates its input. */
export function normalizeSchema(schema: SchemaObject, options: NormalizeOptions): SchemaObject {
	return visit({ direction: options.direction, ordinary: options.ordinary === true, seen: new Map() }, schema)
}

function visit(ctx: Normalizing, node: SchemaObject): SchemaObject {
	const cached = ctx.seen.get(node)
	if (cached !== undefined) return cached
	const out: SchemaObject = {}
	ctx.seen.set(node, out)
	for (const [key, value] of Object.entries(node)) {
		if (!OPENAPI_ONLY.has(key)) translate(ctx, out, key, value)
	}
	resolveExclusiveBounds(out)
	/* Properties that do not travel in this direction are neither allowed nor required. */
	dropProperties(out, ctx.direction === "request" ? "readOnly" : "writeOnly")
	if (ctx.ordinary) dropPrivileged(out)
	/* `nullable` widens whatever the schema otherwise allows. 3.1 has no such keyword, but
	 * generators still emit it, and reading it there costs nothing. */
	if (node.nullable === true) return nullable(out)
	return out
}

/** Writes one keyword of a schema node into `out`, translating any subschemas it holds. */
function translate(ctx: Normalizing, out: SchemaObject, key: string, value: unknown): void {
	if (SINGLE.has(key) && isSchema(value)) out[key] = visit(ctx, value)
	else if (LIST.has(key) && Array.isArray(value)) out[key] = visitEach(ctx, value)
	/* Draft-04 tuple form: positional item schemas. */
	else if (key === "items" && Array.isArray(value)) out.prefixItems = visitEach(ctx, value)
	else if (MAP.has(key) && isSchema(value)) {
		const map: SchemaObject = {}
		for (const [name, sub] of Object.entries(value)) map[name] = isSchema(sub) ? visit(ctx, sub) : sub
		out[key] = map
	} else out[key] = value
}

function visitEach(ctx: Normalizing, items: unknown[]): unknown[] {
	return items.map((item) => (isSchema(item) ? visit(ctx, item) : item))
}

function resolveExclusiveBounds(out: SchemaObject): void {
	for (const [flag, bound] of BOUNDS) {
		if (typeof out[flag] !== "boolean") continue
		if (out[flag] === true && typeof out[bound] === "number") {
			out[flag] = out[bound]
			delete out[bound]
		} else delete out[flag]
	}
}

function dropProperties(out: SchemaObject, hidden: "readOnly" | "writeOnly"): void {
	if (!isSchema(out.properties)) return
	const properties = { ...out.properties }
	const dropped = Object.entries(properties)
		.filter(([, sub]) => isSchema(sub) && sub[hidden] === true)
		.map(([name]) => name)
	for (const name of dropped) delete properties[name]
	out.properties = properties
	if (Array.isArray(out.required)) out.required = out.required.filter((name) => !dropped.includes(String(name)))
}

/* An optional property marked x-privileged: an ordinary writer never sends it. */
function dropPrivileged(out: SchemaObject): void {
	if (!isSchema(out.properties)) return
	const required = Array.isArray(out.required) ? out.required : []
	out.properties = Object.fromEntries(
		Object.entries(out.properties).filter(
			([name, sub]) => !isSchema(sub) || sub[PRIVILEGED] !== true || required.includes(name),
		),
	)
}

/** `schema` or null — by widening `type` and `enum` where that is exact, by a union where not. */
function nullable(schema: SchemaObject): SchemaObject {
	const type = schema.type
	const typed = typeof type === "string" || Array.isArray(type)
	const composite = ["allOf", "anyOf", "oneOf", "$ref", "not", "const"].some((key) => key in schema)
	if (typed && !composite) {
		const out: SchemaObject = { ...schema }
		const types = Array.isArray(type) ? [...type] : [type]
		if (!types.includes("null")) types.push("null")
		out.type = types
		if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null]
		return out
	}
	return { anyOf: [schema, { type: "null" }] }
}

export type ScalarKind = "string" | "number" | "integer" | "boolean"

const SCALAR_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean"])

/* What makes an allOf branch say something about the type, rather than annotate it. */
const TYPING_KEYS = ["type", "oneOf", "anyOf", "allOf", "enum", "const", "properties", "items"] as const

/**
 * The scalar kinds a property's schema admits, nulls aside, or `undefined` when it is not a scalar
 * field: an object, an array, a schema that admits only null, or one that says nothing.
 *
 * Every spelling of a nullable scalar reads the same: a 3.1 type list (`["string", "null"]`), 3.0
 * `nullable: true` beside the type, and a `oneOf` or `anyOf` with a `{type: "null"}` branch. An
 * untyped `enum` or `const` is read by its values, and an `allOf` with one typed branch — a `$ref`
 * with a description beside it, once dereferenced — by that branch.
 */
export function scalarKinds(schema: unknown): ScalarKind[] | undefined {
	if (!isSchema(schema)) return undefined
	const kinds = kindsOf(schema)
	return kinds === undefined || kinds.length === 0 ? undefined : [...new Set(kinds)]
}

/* The scalar kinds of `schema`; empty when it admits only null, `undefined` when not a scalar. */
function kindsOf(schema: SchemaObject): ScalarKind[] | undefined {
	const { type } = schema
	if (typeof type === "string") return type === "null" ? [] : kindsOfTypes([type])
	if (Array.isArray(type)) return type.length === 0 ? undefined : kindsOfTypes(type)
	const branches = schema.oneOf ?? schema.anyOf
	if (Array.isArray(branches)) return kindsOfBranches(branches)
	if (Array.isArray(schema.allOf)) return kindsOfAll(schema.allOf)
	if (Array.isArray(schema.enum)) return kindsOfValues(schema.enum)
	return "const" in schema ? kindsOfValues([schema.const]) : undefined
}

function kindsOfTypes(types: readonly unknown[]): ScalarKind[] | undefined {
	const kinds: ScalarKind[] = []
	for (const type of types) {
		if (type === "null") continue
		if (typeof type !== "string" || !SCALAR_KINDS.has(type)) return undefined
		kinds.push(type as ScalarKind)
	}
	return kinds
}

/* Every branch a scalar or null; the kinds of them all. */
function kindsOfBranches(branches: readonly unknown[]): ScalarKind[] | undefined {
	const kinds: ScalarKind[] = []
	for (const branch of branches) {
		const branchKinds = isSchema(branch) ? kindsOf(branch) : undefined
		if (branchKinds === undefined) return undefined
		kinds.push(...branchKinds)
	}
	return kinds
}

function kindsOfAll(branches: readonly unknown[]): ScalarKind[] | undefined {
	const typed = branches.filter((branch) => isSchema(branch) && TYPING_KEYS.some((key) => key in branch))
	return typed.length === 1 ? kindsOf(typed[0] as SchemaObject) : undefined
}

function kindsOfValues(values: readonly unknown[]): ScalarKind[] | undefined {
	const kinds: ScalarKind[] = []
	for (const value of values) {
		if (value === null) continue
		const kind = typeof value
		if (kind !== "string" && kind !== "number" && kind !== "boolean") return undefined
		kinds.push(kind)
	}
	return kinds
}
