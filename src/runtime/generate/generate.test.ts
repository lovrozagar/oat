import { describe, expect, it } from "vitest"
import { instanceErrors } from "../validate.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { documentDefs } from "../../spec/load/defs.ts"
import { normalizeSchema } from "../../spec/schema.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { generate } from "./generate.ts"
import type { Variant } from "./types.ts"

const noRandomness = (): number => {
	throw new TypeError("no randomness")
}

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

/* A property test: random schemas, each satisfiable by construction, and every value generated
 * from one must validate against it. Seeded, so a failure names a schema that replays. */
/** A seeded linear congruential generator, and the property names drawn so far. */
class Draw {
	#state: number
	names = 0

	constructor(seed: number) {
		this.#state = seed >>> 0
	}

	next(): number {
		this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0
		return this.#state / 2 ** 32
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.next() * items.length)] as T
	}

	int(lo: number, hi: number): number {
		return lo + Math.floor(this.next() * (hi - lo + 1))
	}
}

function scalar(d: Draw): Record<string, unknown> {
	switch (d.pick(["string", "format", "integer", "number", "boolean", "enum", "const"] as const)) {
		case "string": {
			const min = d.int(0, 5)
			return { maxLength: min + d.int(0, 20), minLength: min, type: "string" }
		}
		case "format":
			return {
				format: d.pick(["date", "date-time", "time", "uuid", "email", "uri", "hostname", "ipv4"]),
				type: "string",
			}
		case "integer": {
			const lo = d.int(-50, 50)
			const step = d.pick([undefined, 2, 3, 5])
			const schema: Record<string, unknown> = { maximum: lo + d.int(10, 100), minimum: lo, type: "integer" }
			if (step !== undefined) schema.multipleOf = step
			return schema
		}
		case "number": {
			const lo = d.int(-10, 10)
			return d.next() < 0.5
				? { maximum: lo + d.int(1, 20), minimum: lo, type: "number" }
				: { exclusiveMaximum: lo + d.int(2, 20), exclusiveMinimum: lo, type: "number" }
		}
		case "boolean":
			return { type: "boolean" }
		case "enum":
			return { enum: ["a", "b", "c"].slice(0, d.int(1, 3)), type: "string" }
		default:
			return { const: d.pick(["fixed", 7, true]) }
	}
}

function node(d: Draw, depth: number): Record<string, unknown> {
	const roll = d.next()
	if (depth >= 2 || roll < 0.5) {
		const base = scalar(d)
		return d.next() < 0.2 ? { anyOf: [base, { type: "null" }] } : base
	}
	if (roll < 0.7) {
		const lo = d.int(0, 2)
		return { items: node(d, depth + 1), maxItems: lo + d.int(0, 3), minItems: lo, type: "array" }
	}
	if (roll < 0.85) return object(d, depth + 1)
	return { allOf: [object(d, depth + 1), object(d, depth + 1)] }
}

function object(d: Draw, depth: number): Record<string, unknown> {
	const properties: Record<string, unknown> = {}
	const required: string[] = []
	for (let i = 0; i < d.int(1, 4); i++) {
		/* Unique, so allOf branches never declare one property two incompatible ways. */
		const name = `p${depth}_${i}_${(d.names += 1)}`
		properties[name] = node(d, depth)
		if (d.next() < 0.6) required.push(name)
	}
	return { properties, required, type: "object" }
}

function randomSchemas(seed: number, count: number): Array<Record<string, unknown>> {
	const d = new Draw(seed)
	return Array.from({ length: count }, () => object(d, 0))
}

describe("every generated value validates against a random schema it came from", () => {
	it("holds for 300 seeded schemas under every variant", () => {
		for (const [n, schema] of randomSchemas(20261009, 300).entries()) {
			const { doc } = dereference(documentFor(schema, "3.1.0"))
			const defs = documentDefs(doc)
			const normalized = normalizeSchema(requestSchema(doc), { direction: "request" })
			for (const variant of VARIANTS) {
				for (let index = 0; index < 3; index++) {
					const result = generate(normalized, { defs, index, nonce: "n0nce", variant })
					const where = `schema #${n} ${variant} #${index}: ${JSON.stringify(schema)}`
					expect(result, where).toMatchObject({ ok: true })
					if (!result.ok) continue
					expect(instanceErrors(normalized, result.value, defs), where).toEqual([])
				}
			}
		}
	})
})

describe("generate", () => {
	it("fills every option it is not given", () => {
		expect(generate({ type: "string" })).toEqual({ ok: true, value: "Quarterly Report 0" })
		expect(generate({ type: "number" })).toEqual({ ok: true, value: 1.5 })
	})

	it("points at the root when the root itself cannot be made", () => {
		expect(generate(false)).toEqual({ ok: false, pointer: "/", reason: "the schema admits no value (false)" })
	})

	it("reports a schema nested past the stack as too deep, not a crash", () => {
		let schema: Record<string, unknown> = { type: "string" }
		for (let level = 0; level < 20_000; level++) schema = { oneOf: [schema] }
		expect(generate(schema)).toEqual({ ok: false, pointer: "/", reason: "the schema nests too deeply to generate" })
	})

	it("lets an error that is not about the schema through", () => {
		expect(() => generate({ type: "number" }, { rand: noRandomness })).toThrow("no randomness")
	})
})
