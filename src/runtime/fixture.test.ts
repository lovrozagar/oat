import { describe, expect, it } from "vitest"
import {
	COHORT,
	buildCohort,
	ensureDistinctUniqueValues,
	type CohortMember,
	FixtureOverflow,
	generateBody,
	isOverflowError,
	mulberry32,
	overflowFrom,
} from "./fixture.ts"
import { codePointCount } from "./payloads.ts"
import { dereference } from "../spec/load/dereference.ts"
import { documentDefs } from "../spec/load/defs.ts"
import type { OpenApiDocument } from "../spec/types.ts"

const length = (value: unknown) => codePointCount(String(value ?? ""))

/* The variants whose `field` fails `ok`: empty when every member passes. */
function failing(members: CohortMember[], field: string, ok: (value: unknown) => boolean): string[] {
	return members.filter((member) => !ok(member.body[field])).map((member) => member.variant)
}

describe("buildCohort on nested and cyclic schemas", () => {
	it("seeds a column object whose schema has default: {}", () => {
		const members = buildCohort(
			{
				properties: {
					columns: {
						items: {
							additionalProperties: {},
							default: {},
							properties: { name: { type: "string" } },
							required: ["name"],
							type: "object",
						},
						type: "array",
					},
				},
				required: ["columns"],
				type: "object",
			},
			1,
			{ variants: ["baseline"], operationId: "table.create" },
		)
		expect(members[0]?.body).toBeDefined()
		expect(Array.isArray(members[0]?.body["columns"])).toBe(true)
	})

	it("does not throw on a cyclic $ref: # after deref", () => {
		const { doc } = dereference({
			components: { schemas: { Node: { properties: { child: { $ref: "#" } }, type: "object" } } },
			info: { title: "cycle", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/tables": {
					post: {
						operationId: "table.create",
						requestBody: {
							content: { "application/json": { schema: { $ref: "#" } } },
							required: true,
						},
						responses: { "201": { description: "ok" } },
						"x-entity": { action: "create", identity: "id", name: "table" },
					},
				},
			},
		} as OpenApiDocument)
		const schema = (
			doc.paths?.["/tables"] as { post?: { requestBody?: { content?: Record<string, { schema?: unknown }> } } }
		)?.post?.requestBody?.content?.["application/json"]?.schema as Record<string, unknown>
		expect(() =>
			buildCohort(schema ?? {}, 1, { variants: ["baseline"], defs: documentDefs(doc), operationId: "table.create" }),
		).not.toThrow()
	})
})

describe("buildCohort strings", () => {
	it("puts several scripts on the unicode cohort member", () => {
		const [member] = buildCohort(
			{
				properties: { name: { type: "string" } },
				required: ["name"],
				type: "object",
			},
			1,
			{ variants: ["unicode"], operationId: "table.create" },
		)
		const name = String(member?.body["name"] ?? "")
		expect(name).toContain("äöüß")
		expect(name).toContain("čćžšđ")
		expect(name).toContain("привет")
		expect(name).toContain("日本語")
		expect(name).toContain("🙂")
	})
})

describe("buildCohort string formats", () => {
	it("generates format: email that passes a conservative regex", () => {
		const [member] = buildCohort(
			{
				properties: { email: { format: "email", type: "string" } },
				required: ["email"],
				type: "object",
			},
			1,
			{ variants: ["baseline"], operationId: "user.create" },
		)
		expect(member?.body["email"]).toMatch(/^[^@]+@[^@]+\.[^@]+$/)
	})

	it("honours minLength and maxLength on every cohort string", () => {
		const members = buildCohort(
			{
				properties: { name: { maxLength: 32, minLength: 3, type: "string" } },
				required: ["name"],
				type: "object",
			},
			1,
			{ variants: COHORT, operationId: "thing.create" },
		)
		expect(members).toHaveLength(COHORT.length)
		expect(failing(members, "name", (value) => length(value) >= 3 && length(value) <= 32)).toEqual([])
	})

	it("pads a handle pattern to minLength instead of emitting a", () => {
		const pattern = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
		const members = buildCohort(
			{
				properties: { handle: { maxLength: 32, minLength: 3, pattern, type: "string" } },
				required: ["handle"],
				type: "object",
			},
			1,
			{ variants: COHORT, operationId: "user.create" },
		)
		const re = new RegExp(pattern)
		const handle = (value: unknown) => typeof value === "string" && re.test(value) && codePointCount(value) >= 3
		expect(failing(members, "handle", handle)).toEqual([])
	})
})

describe("generateBody", () => {
	it("omits optional and records missingRequired when minLength exceeds maxLength", () => {
		const { body, missingRequired } = generateBody(
			{
				properties: {
					opt: { maxLength: 3, minLength: 10, type: "string" },
					req: { maxLength: 3, minLength: 10, type: "string" },
				},
				required: ["req"],
				type: "object",
			},
			{ index: 0, rand: mulberry32(1), variant: "baseline" },
		)
		expect(body["opt"]).toBeUndefined()
		expect(body["req"]).toBeUndefined()
		expect(missingRequired).toContain("/req")
	})
})

describe("buildCohort padding", () => {
	it("pads format: email to minLength without breaking the address", () => {
		const [member] = buildCohort(
			{
				properties: { email: { format: "email", minLength: 40, type: "string" } },
				required: ["email"],
				type: "object",
			},
			1,
			{ variants: ["baseline"], operationId: "user.create" },
		)
		const email = String(member?.body["email"] ?? "")
		expect(codePointCount(email)).toBeGreaterThanOrEqual(40)
		expect(email).toMatch(/^[^@]+@[^@]+\.[^@]+$/)
	})

	it("honours minLength when maxLength is unset", () => {
		const members = buildCohort(
			{
				properties: { name: { minLength: 5, type: "string" } },
				required: ["name"],
				type: "object",
			},
			1,
			{ variants: COHORT, operationId: "thing.create" },
		)
		expect(failing(members, "name", (value) => codePointCount(String(value ?? "")) >= 5)).toEqual([])
	})

	it("does not invent a slug when padding a pattern would break it", () => {
		const { body, missingRequired } = generateBody(
			{
				properties: { code: { maxLength: 32, minLength: 3, pattern: "^a$", type: "string" } },
				required: ["code"],
				type: "object",
			},
			{ index: 0, rand: mulberry32(1), variant: "baseline" },
		)
		expect(body["code"]).toBeUndefined()
		expect(missingRequired).toContain("/code")
	})
})

describe("overflow", () => {
	it("names table.create when generation still overflows", () => {
		const overflow = overflowFrom(new RangeError("Maximum call stack size exceeded"), "table.create")
		expect(overflow).toBeInstanceOf(FixtureOverflow)
		expect(overflow.message).toContain("table.create")
		expect(overflow.message).not.toMatch(/\bunknown\b/)
		expect(isOverflowError(overflow)).toBe(true)
	})
})

/* A schema whose reading throws: what a hook-built or proxied document can hand over. */
function throwing(key: string): Record<string, unknown> {
	return Object.defineProperty({ type: "object" }, key, {
		enumerable: true,
		get() {
			throw new Error("boom")
		},
	})
}

describe("buildCohort on a schema that cannot be read", () => {
	it("reports it as an overflow with the error, never a crash", () => {
		expect(() =>
			buildCohort(throwing("properties"), 1, { variants: ["baseline"], operationId: "note.create" }),
		).toThrow(FixtureOverflow)
		expect(() =>
			buildCohort(throwing("properties"), 1, { variants: ["baseline"], operationId: "note.create" }),
		).toThrow(/boom/)
	})
})

describe("mulberry32", () => {
	it("is the same sequence for the same seed, in [0, 1)", () => {
		const a = mulberry32(42)
		const b = mulberry32(42)
		const draws = [a(), a(), a()]
		expect([b(), b(), b()]).toEqual(draws)
		expect(draws.every((n) => n >= 0 && n < 1)).toBe(true)
		expect(mulberry32(43)()).not.toBe(draws[0])
	})
})

describe("overflow errors", () => {
	it("keeps the field an overflow names, or the caller's pointer when it named none", () => {
		const named = overflowFrom(new FixtureOverflow("a.create", "/name", "too long"), "b.create")
		expect([named.operationId, named.pointer, named.reason]).toEqual(["b.create", "/name", "too long"])
		expect(named.message).toBe(
			"cannot generate a valid body for b.create at /name: too long — supply one with hooks.resolveInput",
		)
		const root = overflowFrom(new FixtureOverflow("a.create", "/"), "b.create", "/body")
		expect([root.pointer, root.message]).toEqual(["/body", "fixture generation overflow on b.create (/body)"])
		expect(overflowFrom(new Error("x"), "c.create").pointer).toBe("/")
	})

	it("counts a FixtureOverflow and a RangeError as an overflow, nothing else", () => {
		expect(isOverflowError(new FixtureOverflow("a", "/"))).toBe(true)
		expect(isOverflowError(new RangeError("deep"))).toBe(true)
		expect(isOverflowError(new Error("other"))).toBe(false)
	})
})

describe("buildCohort's self-check", () => {
	const impossible = { maxLength: 1, minLength: 5, type: "string" }

	it("names the operation and field it cannot make, defaulting the operation to unknown", () => {
		const schema = { properties: { a: impossible }, required: ["a"], type: "object" }
		expect(() => buildCohort(schema, 1, { variants: ["baseline"] })).toThrow(
			"cannot generate a valid body for unknown at /a: minLength 5 exceeds maxLength 1",
		)
	})

	it("refuses a body the schema rejects, and accepts anything for a vacuous one", () => {
		expect(() =>
			buildCohort({ not: {}, type: "object" }, 1, { variants: ["baseline"], operationId: "x.create" }),
		).toThrow("cannot generate a valid body for x.create at /: (root) must NOT be valid")
		expect(() => buildCohort({ type: "string" }, 1, { variants: ["baseline"] })).toThrow(/\(root\) must be string/)
		expect(buildCohort(true, 1)).toHaveLength(COHORT.length)
	})

	it("passes definitions and the nonce through, salting distinct fields", () => {
		const schema = { properties: { name: { $ref: "oat-defs#/$defs/Name" } }, required: ["name"], type: "object" }
		const options = { defs: { Name: { type: "string" } }, distinct: new Set(["name"]), nonce: "n1" }
		const [member] = buildCohort(schema, 1, { ...options, variants: ["baseline"] })
		expect(String(member?.body["name"])).toContain("n1")
	})
})

describe("generateBody's partial bodies", () => {
	const impossible = { maxLength: 1, minLength: 5, type: "string" }

	it("is the value as made when it is not an object, and the root when the root cannot be made", () => {
		expect(generateBody({ type: "string" }, { index: 0, rand: mulberry32(1), variant: "baseline" })).toEqual({
			body: {},
			missingRequired: [],
		})
		expect(generateBody(impossible, { index: 0, rand: mulberry32(1), variant: "baseline" })).toEqual({
			body: {},
			missingRequired: ["/"],
		})
		expect(generateBody(false, { index: 0, rand: mulberry32(1), variant: "baseline" })).toEqual({
			body: {},
			missingRequired: ["/"],
		})
	})

	it("drops a field required only through allOf and makes the rest", () => {
		const schema = {
			allOf: [{ required: ["a"] }],
			properties: { a: impossible, b: { type: "string" } },
			type: "object",
		}
		const { body, missingRequired } = generateBody(schema, { index: 0, rand: mulberry32(1), variant: "baseline" })
		expect(missingRequired).toEqual(["/a"])
		expect(Object.keys(body).toSorted()).toEqual(["a", "b"])
	})
})

/* A body schema with an optional x-privileged property, a nested one, and `required` besides. */
const marked = (required: string[]) => ({
	properties: {
		name: { type: "string" },
		nested: {
			properties: { plan: { type: "string", "x-privileged": true }, title: { type: "string" } },
			required: ["title"],
			type: "object",
		},
		verified: { type: "boolean", "x-privileged": true },
	},
	required: ["name", "nested", ...required],
	type: "object",
})

describe("bodies an ordinary writer sends", () => {
	const draw = { index: 0, rand: mulberry32(1), variant: "baseline" } as const

	it("leaves out every optional property marked x-privileged, nested ones too, in every member", () => {
		for (const { body } of buildCohort(marked([]), 7)) {
			expect(body).not.toHaveProperty("verified")
			expect(body["nested"]).not.toHaveProperty("plan")
		}
		expect(generateBody(marked([]), draw).body).not.toHaveProperty("verified")
	})

	it("keeps a required one at a schema-valid value: only the highest rank may send that create", () => {
		const [member] = buildCohort(marked(["verified"]), 7, { variants: ["baseline"] })
		expect(typeof member?.body["verified"]).toBe("boolean")
	})
})

const cohort = (...bodies: Record<string, unknown>[]): CohortMember[] =>
	bodies.map((body, index) => ({ body, variant: COHORT[index] ?? "baseline" }))

describe("ensureDistinctUniqueValues", () => {
	const schema = {
		properties: { code: { type: "string" }, kind: { enum: ["only"], type: "string" }, n: { type: "integer" } },
		type: "object",
	}

	it("leaves a cohort alone when there is no set, or nothing to collide with", () => {
		const members = cohort({ code: "a" }, { code: "a" })
		expect(ensureDistinctUniqueValues(members, [], { schema })).toEqual({ gap: null, members })
		expect(ensureDistinctUniqueValues(members.slice(0, 1), [["code"]], { schema }).members).toHaveLength(1)
	})

	it("redraws a colliding column until every tuple differs", () => {
		const members = cohort({ code: "a", n: 1 }, { code: "a", n: 1 }, { code: "b", n: 1 })
		const result = ensureDistinctUniqueValues(members, [["code"], ["n", "code"]], { schema, nonce: "r" })
		expect(result.gap).toBeNull()
		expect(new Set(result.members.map((member) => member.body["code"])).size).toBe(3)
		expect(result.members.map((member) => member.variant)).toEqual(COHORT.slice(0, 3))
	})

	it("drops the members a schema cannot tell apart, and says so", () => {
		const members = cohort({ kind: "only" }, { kind: "only" }, { other: 1 }, { other: 1 })
		const result = ensureDistinctUniqueValues(members, [["kind"], ["other"]], { schema, defs: {} })
		expect(result.members.map((member) => member.body)).toEqual([{ kind: "only" }, { other: 1 }])
		expect(result.gap).toBe(
			"x-unique cannot express distinct values for [kind]; [other] within the schema; extra variants skipped",
		)
	})

	it("stops redrawing a column its schema cannot make", () => {
		const unmakeable = { properties: { code: { maxLength: 1, minLength: 5, type: "string" } }, type: "object" }
		const result = ensureDistinctUniqueValues(cohort({ code: "a" }, { code: "a" }), [["code"]], { schema: unmakeable })
		expect(result.members).toHaveLength(1)
		expect(result.gap).not.toBeNull()
	})

	it("treats a set no body fills as never colliding, and a boolean schema as having no columns", () => {
		const members = cohort({ code: "a" }, { code: "a" })
		expect(ensureDistinctUniqueValues(members, [["absent"]], { schema }).gap).toBeNull()
		expect(ensureDistinctUniqueValues(members, [["code"]], { schema: true }).members).toHaveLength(1)
	})
})

describe("generateBody on a field required through allOf", () => {
	it("reports a field it cannot make, and stops", () => {
		const schema = {
			allOf: [{ properties: { a: { maxLength: 1, minLength: 5, type: "string" } }, required: ["a"], type: "object" }],
		}
		expect(generateBody(schema, { index: 0, rand: () => 0.5, variant: "baseline" }).missingRequired).toEqual(["/a"])
	})
})
