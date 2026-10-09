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

import type { SchemaObject } from "./types.ts"

export type Direction = "request" | "response"

export interface NormalizeOptions {
	direction: Direction
}

/** Keywords whose value is one subschema. */
const SINGLE = [
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
] as const

/** Keywords whose value is a list of subschemas. */
const LIST = ["allOf", "anyOf", "oneOf", "prefixItems"] as const

/** Keywords whose value maps names to subschemas. */
const MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const

/** OpenAPI annotations that are not JSON Schema keywords — removed from schema nodes only. */
const OPENAPI_ONLY = new Set(["nullable", "example", "discriminator", "xml", "externalDocs"])

function isSchema(value: unknown): value is SchemaObject {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Translates `schema` into JSON Schema 2020-12 as seen in `direction`. Never mutates its input. */
export function normalizeSchema(schema: SchemaObject, options: NormalizeOptions): SchemaObject {
	const seen = new Map<object, SchemaObject>()

	const visit = (node: SchemaObject): SchemaObject => {
		const cached = seen.get(node)
		if (cached !== undefined) return cached
		const out: SchemaObject = {}
		seen.set(node, out)

		for (const [key, value] of Object.entries(node)) {
			if (OPENAPI_ONLY.has(key)) continue
			if ((SINGLE as readonly string[]).includes(key) && isSchema(value)) out[key] = visit(value)
			else if ((LIST as readonly string[]).includes(key) && Array.isArray(value)) {
				out[key] = value.map((item) => (isSchema(item) ? visit(item) : item))
			} else if (key === "items" && Array.isArray(value)) {
				/* Draft-04 tuple form: positional item schemas. */
				out.prefixItems = value.map((item) => (isSchema(item) ? visit(item) : item))
			} else if ((MAP as readonly string[]).includes(key) && isSchema(value)) {
				const map: SchemaObject = {}
				for (const [name, sub] of Object.entries(value)) map[name] = isSchema(sub) ? visit(sub) : sub
				out[key] = map
			} else out[key] = value
		}

		/* OpenAPI 3.0 exclusive bounds are booleans qualifying `minimum` / `maximum`. */
		for (const [flag, bound] of [
			["exclusiveMinimum", "minimum"],
			["exclusiveMaximum", "maximum"],
		] as const) {
			if (typeof out[flag] !== "boolean") continue
			if (out[flag] === true && typeof out[bound] === "number") {
				out[flag] = out[bound]
				delete out[bound]
			} else delete out[flag]
		}

		/* Properties that do not travel in this direction are neither allowed nor required. */
		const hidden = options.direction === "request" ? "readOnly" : "writeOnly"
		if (isSchema(out.properties)) {
			const properties = { ...out.properties }
			const dropped = Object.entries(properties)
				.filter(([, sub]) => isSchema(sub) && sub[hidden] === true)
				.map(([name]) => name)
			for (const name of dropped) delete properties[name]
			out.properties = properties
			if (Array.isArray(out.required)) out.required = out.required.filter((name) => !dropped.includes(String(name)))
		}

		/* `nullable` widens whatever the schema otherwise allows. 3.1 has no such keyword, but
		 * generators still emit it, and reading it there costs nothing. */
		if (node.nullable === true) return nullable(out)
		return out
	}

	return visit(schema)
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
