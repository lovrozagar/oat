import { describe, expect, it } from "vitest"
import type { FilterNode } from "../query-types.ts"
import { and, fieldsIn } from "./tree.ts"

const a: FilterNode = { field: "a", kind: "isnull", negate: false }
const b: FilterNode = { field: "b", insensitive: false, kind: "like", pattern: [] }

describe("and", () => {
	it("matches everything given nothing, is the one predicate given one, and joins several", () => {
		expect(and()).toEqual({ kind: "const", value: true })
		expect(and(null, null)).toEqual({ kind: "const", value: true })
		expect(and(null, a)).toBe(a)
		expect(and(a, null, b)).toEqual({ children: [a, b], kind: "and" })
	})
})

describe("fieldsIn", () => {
	it("names every field a predicate reads, through every group", () => {
		const tree: FilterNode = {
			children: [
				a,
				{ children: [b, { kind: "const", value: true }], kind: "or" },
				{ caseSensitive: false, fields: ["c", "d"], kind: "search", mode: "contains", token: "x" },
				{ field: "e", kind: "contains", substring: false, value: "x" },
				{ asText: false, field: "f", kind: "in", negate: false, values: [] },
				{ asText: false, field: "g", kind: "cmp", nullsMatch: false, op: "eq", value: 1 },
			],
			kind: "and",
		}
		expect(fieldsIn(tree)).toEqual(["a", "b", "c", "d", "e", "f", "g"])
		expect(fieldsIn({ kind: "const", value: false })).toEqual([])
	})
})
