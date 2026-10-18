import { describe, expect, it } from "vitest"
import { describeEffectHold, effectCardinality, effectHolds } from "./cardinality.ts"

describe("effectCardinality / effectHolds", () => {
	it("defaults to exact count 1 and describes both modes", () => {
		expect(effectCardinality({ entity: "table", op: "create" })).toEqual({ count: 1, mode: "exact" })
		expect(effectCardinality({ count: 3, entity: "row", op: "append" })).toEqual({ count: 3, mode: "exact" })
		expect(effectCardinality({ entity: "row", min: 1, op: "append" })).toEqual({ min: 1, mode: "min" })
		expect(describeEffectHold({ entity: "table", op: "create" })).toBe("create × 1")
		expect(describeEffectHold({ entity: "row", min: 2, op: "append" })).toBe("append ≥ 2")
	})

	it("holds exact and at-least create/append/delete, and forbids resize on update", () => {
		const create = { entity: "table", op: "create" as const }
		const appendMin = { entity: "row", min: 1, op: "append" as const }
		const del = { count: 2, entity: "row", op: "delete" as const }
		const delMin = { entity: "row", min: 1, op: "delete" as const }
		const update = { entity: "row", op: "update" as const }
		expect(effectHolds(create, 1, 1, 0)).toBe(true)
		expect(effectHolds(create, 2, 2, 0)).toBe(false)
		expect(effectHolds(appendMin, 5, 5, 0)).toBe(true)
		expect(effectHolds(appendMin, 0, 0, 0)).toBe(false)
		expect(effectHolds(del, -2, 0, 2)).toBe(true)
		expect(effectHolds(del, -1, 0, 1)).toBe(false)
		expect(effectHolds(delMin, -3, 0, 3)).toBe(true)
		expect(effectHolds(delMin, 0, 0, 0)).toBe(false)
		expect(effectHolds(update, 0, 0, 0)).toBe(true)
		expect(effectHolds(update, 1, 1, 0)).toBe(false)
		expect(effectHolds({ entity: "row", op: "replace" }, 0, 0, 0)).toBe(true)
	})
})
