import { describe, expect, it } from "vitest"
import { type Variant, absentIdentifier, distinctValue, filterSentinel, generate } from "../src/runtime/generate.ts"
import { instanceErrors } from "../src/runtime/validate.ts"
import { dereference, documentDefs } from "../src/spec/load.ts"
import { normalizeSchema } from "../src/spec/schema.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

const VARIANTS: Variant[] = [
	"baseline",
	"lexical-first",
	"lexical-last",
	"null-heavy",
	"unicode",
	"metacharacter",
	"boundary",
]

/** Schemas real documents contain, each once as written for OpenAPI 3.0 or 3.1. */
const SCHEMAS: Record<string, Record<string, unknown>> = {
	"rich create body": {
		properties: {
			due_at: { format: "date-time", type: "string" },
			end: { $ref: "#/components/schemas/Point" },
			kind: { const: "table" },
			start: { $ref: "#/components/schemas/Point" },
			weight: { maximum: 10, minimum: 1, multipleOf: 0.5, type: "number" },
		},
		required: ["due_at", "weight", "kind", "start", "end"],
		type: "object",
	},
	"bounds and formats": {
		properties: {
			born: { format: "date", type: "string" },
			code: { maxLength: 6, minLength: 6, pattern: "^[A-Z]{3}[0-9]{3}$", type: "string" },
			count: { exclusiveMaximum: 5, exclusiveMinimum: 0, type: "integer" },
			email: { format: "email", maxLength: 40, type: "string" },
			host: { format: "hostname", type: "string" },
			id: { format: "uuid", type: "string" },
			ip: { format: "ipv4", type: "string" },
			at: { format: "time", type: "string" },
			ratio: { maximum: 1, minimum: 0, type: "number" },
			site: { format: "uri", type: "string" },
			step: { minimum: 3, multipleOf: 7, type: "integer" },
		},
		required: ["code", "count", "step", "ratio"],
		type: "object",
	},
	"composition and unions": {
		allOf: [
			{ properties: { name: { maxLength: 12, type: "string" } }, required: ["name"] },
			{ properties: { status: { enum: ["a", "b"], type: "string" } }, required: ["status"] },
		],
		properties: {
			pet: {
				oneOf: [
					{ properties: { bark: { type: "boolean" } }, required: ["bark"], type: "object" },
					{ properties: { meow: { type: "boolean" } }, required: ["meow"], type: "object" },
				],
				properties: { kind: { type: "string" } },
				required: ["kind"],
			},
			tags: { items: { enum: ["x", "y", "z"] }, maxItems: 3, minItems: 2, type: "array", uniqueItems: true },
			note: { anyOf: [{ maxLength: 20, type: "string" }, { type: "null" }] },
		},
		type: "object",
	},
	"openapi 3.0 nullable and exclusive": {
		properties: {
			limit: { exclusiveMinimum: true, maximum: 50, minimum: 10, type: "integer" },
			nick: { nullable: true, type: "string" },
			tier: { enum: ["gold", "silver"], nullable: true, type: "string" },
		},
		required: ["limit", "nick"],
		type: "object",
	},
	recursive: {
		properties: { root: { $ref: "#/components/schemas/Node" } },
		required: ["root"],
		type: "object",
	},
	"read-only fields are not sent": {
		properties: {
			id: { readOnly: true, type: "string" },
			name: { type: "string" },
		},
		required: ["id", "name"],
		type: "object",
	},
}

function documentFor(schema: Record<string, unknown>, version: string): OpenApiDocument {
	return {
		components: {
			schemas: {
				Node: {
					properties: {
						children: { items: { $ref: "#/components/schemas/Node" }, type: "array" },
						name: { type: "string" },
					},
					required: ["name"],
					type: "object",
				},
				Point: {
					additionalProperties: false,
					properties: { x: { type: "integer" }, y: { type: "integer" } },
					required: ["x", "y"],
					type: "object",
				},
			},
		},
		info: { title: "t", version: "1" },
		openapi: version,
		paths: {
			"/things": {
				post: {
					requestBody: { content: { "application/json": { schema } } },
					responses: { "201": { description: "ok" } },
				},
			},
		},
	} as OpenApiDocument
}

function requestSchema(doc: OpenApiDocument): Record<string, unknown> {
	const item = (doc.paths?.["/things"] ?? {}) as unknown as {
		post: { requestBody: { content: Record<string, { schema: unknown }> } }
	}
	const post = item.post
	return post.requestBody.content["application/json"]?.schema as Record<string, unknown>
}

describe("generated values validate against the schema they came from", () => {
	for (const [name, schema] of Object.entries(SCHEMAS)) {
		for (const version of ["3.0.3", "3.1.0"]) {
			it(`${name} (${version})`, () => {
				const { doc } = dereference(documentFor(schema, version))
				const defs = documentDefs(doc)
				const normalized = normalizeSchema(requestSchema(doc), { direction: "request" })
				/* The control: an empty body is invalid, so the validator must say so. */
				expect(instanceErrors(normalized, {}, defs).length, "validator is live").toBeGreaterThan(0)
				for (const variant of VARIANTS) {
					for (let index = 0; index < 12; index++) {
						const result = generate(normalized, { defs, index, nonce: "n0nce", variant })
						expect(result, `${variant} #${index}`).toMatchObject({ ok: true })
						if (!result.ok) continue
						expect(instanceErrors(normalized, result.value, defs), `${variant} #${index}`).toEqual([])
					}
				}
			})
		}
	}

	it("never sends a readOnly property", () => {
		const { doc } = dereference(
			documentFor(SCHEMAS["read-only fields are not sent"] as Record<string, unknown>, "3.1.0"),
		)
		const normalized = normalizeSchema(requestSchema(doc), { direction: "request" })
		const result = generate(normalized)
		expect(result.ok && Object.hasOwn(result.value as object, "id")).toBe(false)
	})

	it("reports a schema nothing can satisfy instead of sending something", () => {
		const result = generate({ properties: { n: { maximum: 1, minimum: 5, type: "integer" } }, required: ["n"] })
		expect(result).toMatchObject({ ok: false, pointer: "/n" })
	})
})

describe("intents", () => {
	it("makes an absent identifier of the identifier's own format", () => {
		expect(absentIdentifier({ format: "uuid", type: "string" }, "n")).toMatchObject({
			ok: true,
			value: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
		})
		const integer = absentIdentifier({ minimum: 1, type: "integer" }, "n")
		expect(integer.ok && Number.isInteger(integer.value)).toBe(true)
	})

	it("changes a value to another valid one", () => {
		const schema = { enum: ["a", "b"], type: "string" }
		expect(distinctValue(schema, "a")).toEqual({ ok: true, value: "b" })
		expect(distinctValue({ const: "only" }, "only")).toMatchObject({ ok: false })
	})

	it("probes a filter with a value of the field's type", () => {
		expect(filterSentinel({ type: "integer" }, "n")).toMatchObject({ ok: true, value: expect.any(Number) })
		expect(filterSentinel({ type: "string" }, "n")).toMatchObject({ ok: true, value: expect.stringContaining("n") })
	})

	it("keeps distinct values distinct across runs", () => {
		const schema = { properties: { name: { maxLength: 24, type: "string" } }, required: ["name"], type: "object" }
		const one = generate(schema, { distinct: new Set(["name"]), nonce: "run1" })
		const two = generate(schema, { distinct: new Set(["name"]), nonce: "run2" })
		expect(one.ok && two.ok && JSON.stringify(one.value) !== JSON.stringify(two.value)).toBe(true)
	})
})
