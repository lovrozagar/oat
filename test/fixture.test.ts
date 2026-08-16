import { describe, expect, it } from "vitest"
import { buildCohort, FixtureOverflow, isOverflowError, overflowFrom } from "../src/runtime/fixture.ts"
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

	it("names table.create when generation still overflows", () => {
		const overflow = overflowFrom(new RangeError("Maximum call stack size exceeded"), "table.create")
		expect(overflow).toBeInstanceOf(FixtureOverflow)
		expect(overflow.message).toContain("table.create")
		expect(overflow.message).not.toMatch(/\bunknown\b/)
		expect(isOverflowError(overflow)).toBe(true)
	})
})
