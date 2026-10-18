import { describe, expect, it } from "vitest"
import { asSchema, effective } from "./effective.ts"

describe("asSchema", () => {
	it("keeps an object and drops anything else", () => {
		expect(asSchema({ type: "string" })).toEqual({ type: "string" })
		expect(asSchema([])).toEqual([])
		expect(asSchema(null)).toBeNull()
		expect(asSchema(true)).toBeNull()
	})
})

describe("effective", () => {
	it("reads a nullable union as its one non-null branch", () => {
		expect(effective(null)).toBeNull()
		expect(effective({ anyOf: [{ type: "array" }, { type: "null" }] })).toEqual({ type: "array" })
		expect(effective({ oneOf: [{ type: "null" }, { type: ["object", "null"] }] })).toEqual({ type: "object" })
		expect(effective({ anyOf: [null, { type: "null" }] })).toBeNull()
		expect(effective({ type: ["array", "null"] })).toEqual({ type: "array" })
	})

	it("leaves a real union and a multi-typed schema as they are", () => {
		const union = { anyOf: [{ type: "string" }, { type: "number" }] }
		expect(effective(union)).toBe(union)
		const multi = { type: ["string", "number"] }
		expect(effective(multi)).toBe(multi)
		const anyOfFirst = { anyOf: [{ type: "string" }, { type: "number" }], oneOf: [{ type: "string" }] }
		expect(effective(anyOfFirst)).toBe(anyOfFirst)
	})

	it("merges allOf members, the outer schema's own properties first in precedence", () => {
		const merged = effective({
			allOf: [
				{ properties: { id: { type: "string" }, name: { type: "number" } }, required: ["id"], type: "object" },
				null,
				{ allOf: [{ items: { type: "string" }, properties: { tag: {} }, required: ["tag", "id"] }] },
				{ items: { type: "number" } },
			],
			properties: { name: { type: "string" } },
		})
		expect(merged).toEqual({
			items: { type: "string" },
			properties: { id: { type: "string" }, name: { type: "string" }, tag: {} },
			required: ["id", "tag"],
			type: "object",
		})
		expect(Object.keys(merged ?? {})).not.toContain("allOf")
		expect(effective({ allOf: [], type: "object" })).toEqual({ type: "object" })
	})
})
