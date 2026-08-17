import { describe, expect, it } from "vitest"
import {
	COHORT,
	buildCohort,
	FixtureOverflow,
	generateBody,
	isOverflowError,
	mulberry32,
	overflowFrom,
} from "../src/runtime/fixture.ts"
import { codePointCount } from "../src/runtime/payloads.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

describe("fixture walk", () => {
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
			["baseline"],
			"table.create",
		)
		expect(members[0]?.body).toBeDefined()
		expect(Array.isArray(members[0]?.body.columns)).toBe(true)
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
		expect(() => buildCohort(schema ?? {}, 1, ["baseline"], "table.create")).not.toThrow()
	})

	it("puts several scripts on the unicode cohort member", () => {
		const [member] = buildCohort(
			{
				properties: { name: { type: "string" } },
				required: ["name"],
				type: "object",
			},
			1,
			["unicode"],
			"table.create",
		)
		const name = String(member?.body.name ?? "")
		expect(name).toContain("äöüß")
		expect(name).toContain("čćžšđ")
		expect(name).toContain("привет")
		expect(name).toContain("日本語")
		expect(name).toContain("🙂")
	})

	it("generates format: email that passes a conservative regex", () => {
		const [member] = buildCohort(
			{
				properties: { email: { format: "email", type: "string" } },
				required: ["email"],
				type: "object",
			},
			1,
			["baseline"],
			"user.create",
		)
		expect(member?.body.email).toMatch(/^[^@]+@[^@]+\.[^@]+$/)
	})

	it("honours minLength and maxLength on every cohort string", () => {
		const members = buildCohort(
			{
				properties: { name: { maxLength: 32, minLength: 3, type: "string" } },
				required: ["name"],
				type: "object",
			},
			1,
			COHORT,
			"thing.create",
		)
		expect(members).toHaveLength(COHORT.length)
		for (const member of members) {
			const value = String(member.body.name ?? "")
			const n = codePointCount(value)
			expect(n, member.variant).toBeGreaterThanOrEqual(3)
			expect(n, member.variant).toBeLessThanOrEqual(32)
		}
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
			COHORT,
			"user.create",
		)
		const re = new RegExp(pattern)
		for (const member of members) {
			const value = member.body.handle
			expect(value, member.variant).not.toBe("a")
			expect(typeof value).toBe("string")
			expect(String(value), member.variant).toMatch(re)
			expect(codePointCount(String(value)), member.variant).toBeGreaterThanOrEqual(3)
		}
	})

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
			"baseline",
			mulberry32(1),
			0,
			"thing.create",
		)
		expect(body.opt).toBeUndefined()
		expect(body.req).toBeUndefined()
		expect(missingRequired).toContain("/req")
	})

	it("pads format: email to minLength without breaking the address", () => {
		const [member] = buildCohort(
			{
				properties: { email: { format: "email", minLength: 40, type: "string" } },
				required: ["email"],
				type: "object",
			},
			1,
			["baseline"],
			"user.create",
		)
		const email = String(member?.body.email ?? "")
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
			COHORT,
			"thing.create",
		)
		for (const member of members) {
			expect(codePointCount(String(member.body.name ?? "")), member.variant).toBeGreaterThanOrEqual(5)
		}
	})

	it("does not invent a slug when padding a pattern would break it", () => {
		const { body, missingRequired } = generateBody(
			{
				properties: { code: { maxLength: 32, minLength: 3, pattern: "^a$", type: "string" } },
				required: ["code"],
				type: "object",
			},
			"baseline",
			mulberry32(1),
			0,
			"thing.create",
		)
		expect(body.code).toBeUndefined()
		expect(missingRequired).toContain("/code")
	})

	it("names table.create when generation still overflows", () => {
		const overflow = overflowFrom(new RangeError("Maximum call stack size exceeded"), "table.create")
		expect(overflow).toBeInstanceOf(FixtureOverflow)
		expect(overflow.message).toContain("table.create")
		expect(overflow.message).not.toMatch(/\bunknown\b/)
		expect(isOverflowError(overflow)).toBe(true)
	})
})
