import { describe, expect, it } from "vitest"
import type { EffectiveQueryCapabilities } from "./effective.ts"
import { anyFieldAllows, fieldAllows, fieldAllowsNulls, opsAreClosed, opsForField } from "./field-ops.ts"
import { emptyCapabilities } from "./merge.ts"

const base: EffectiveQueryCapabilities = { ...emptyCapabilities(), filterable: [{ field: "id" }], source: "tag" }

describe("ops and nulls helpers", () => {
	it("resolves closed ops from the field, type table, then global list", () => {
		expect(opsForField({ field: "id", ops: ["eq"] }, base)).toEqual(["eq"])
		expect(opsAreClosed({ field: "id", ops: ["eq"] }, base)).toBe(true)

		const byType: EffectiveQueryCapabilities = { ...base, operatorsByType: { string: ["eq", "like"] } }
		expect(opsForField({ field: "name", type: "string" }, byType)).toEqual(["eq", "like"])
		expect(opsAreClosed({ field: "name", type: "string" }, byType)).toBe(true)
		expect(opsAreClosed({ field: "n", type: "number" }, byType)).toBe(false)
		expect(opsForField({ field: "n", type: "number" }, base)).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "like"])

		const global: EffectiveQueryCapabilities = { ...base, operators: ["eq", "neq"] }
		expect(opsForField({ field: "id" }, global)).toEqual(["eq", "neq"])
		expect(opsAreClosed({ field: "id" }, global)).toBe(true)
		expect(opsAreClosed({ field: "id" }, base)).toBe(false)
		expect(
			opsForField({ field: "n", type: "number" }, { ...base, operators: ["in"], operatorsByType: { string: ["eq"] } }),
		).toEqual(["in"])
	})

	it("hands out a fresh implicit list each time", () => {
		const first = opsForField({ field: "id" }, base)
		first.push("in")
		expect(opsForField({ field: "id" }, base)).not.toContain("in")
	})

	it("treats a declared alias as allowing the canonical op", () => {
		const caps: EffectiveQueryCapabilities = {
			...base,
			aliases: { ne: "neq" },
			filterable: [{ field: "id", ops: ["eq", "ne"] }],
		}
		expect(fieldAllows({ field: "id", ops: ["eq", "ne"] }, "eq", caps)).toBe(true)
		expect(fieldAllows({ field: "id", ops: ["eq", "ne"] }, "neq", caps)).toBe(true)
		expect(fieldAllows({ field: "id", ops: ["eq", "ne"] }, "in", caps)).toBe(false)
		expect(
			fieldAllows({ field: "id", ops: ["eq"] }, "neq", {
				...caps,
				aliases: { ...caps.aliases, ...({ nope: "neq" } as object as typeof caps.aliases), gt: "gte" },
			}),
		).toBe(false)
		expect(fieldAllows({ field: "id", ops: ["eq"] }, "gte", { ...caps, aliases: { gt: "gte" } })).toBe(false)
		expect(fieldAllows({ field: "id", ops: ["ne"] }, "neq", { ...caps, aliases: { ne: "neq" } })).toBe(true)
		expect(anyFieldAllows(caps, "neq")?.field).toBe("id")
		expect(anyFieldAllows(caps, "contains")).toBeUndefined()
	})

	it("allows nulls from the field or the global sort default", () => {
		const caps: EffectiveQueryCapabilities = { ...base, sort: { nulls: ["last"] } }
		expect(fieldAllowsNulls({ field: "name", nulls: ["first"] }, caps, "first")).toBe(true)
		expect(fieldAllowsNulls({ field: "name" }, caps, "last")).toBe(true)
		expect(fieldAllowsNulls({ field: "name" }, caps, "first")).toBe(false)
		expect(fieldAllowsNulls({ field: "name" }, base, "first")).toBe(false)
		expect(fieldAllowsNulls({ field: "name" }, { ...base, sort: {} }, "first")).toBe(false)
	})
})
