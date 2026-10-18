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
		expect(effectHolds(create, { added: 1, delta: 1, removed: 0 })).toBe(true)
		expect(effectHolds(create, { added: 2, delta: 2, removed: 0 })).toBe(false)
		expect(effectHolds(appendMin, { added: 5, delta: 5, removed: 0 })).toBe(true)
		expect(effectHolds(appendMin, { added: 0, delta: 0, removed: 0 })).toBe(false)
		expect(effectHolds(del, { added: 0, delta: -2, removed: 2 })).toBe(true)
		expect(effectHolds(del, { added: 0, delta: -1, removed: 1 })).toBe(false)
		expect(effectHolds(delMin, { added: 0, delta: -3, removed: 3 })).toBe(true)
		expect(effectHolds(delMin, { added: 0, delta: 0, removed: 0 })).toBe(false)
		expect(effectHolds(update, { added: 0, delta: 0, removed: 0 })).toBe(true)
		expect(effectHolds(update, { added: 1, delta: 1, removed: 0 })).toBe(false)
		expect(effectHolds({ entity: "row", op: "replace" }, { added: 0, delta: 0, removed: 0 })).toBe(true)
	})
})
