import { describe, expect, it } from "vitest"
import { mergeQuery } from "./query.ts"

describe("mergeQuery", () => {
	it("lets the later value win when the grammar does not repeat", () => {
		expect(mergeQuery({ filter: "a", limit: "5" }, { filter: "b" }, false)).toEqual({ filter: "b", limit: "5" })
		expect(mergeQuery({ f: "a", g: "x" }, { f: "b" }, false)).toEqual({ f: "b", g: "x" })
	})

	it("sends both values of a key both sides carry when the grammar repeats", () => {
		expect(mergeQuery({ filter: "a", limit: "5" }, { filter: ["b", "c"], order: "id" }, true)).toEqual({
			filter: ["a", "b", "c"],
			limit: "5",
			order: "id",
		})
		expect(mergeQuery({ filter: ["a"] }, { filter: "b" }, true)).toEqual({ filter: ["a", "b"] })
		expect(mergeQuery({ f: "a", g: "x" }, { f: "b" }, true)).toEqual({ f: ["a", "b"], g: "x" })
		expect(mergeQuery({ f: ["a", "b"] }, { f: ["c"] }, true)).toEqual({ f: ["a", "b", "c"] })
	})

	it("keeps distinct keys from both sides either way", () => {
		expect(mergeQuery({ a: "1" }, { b: "2" }, true)).toEqual({ a: "1", b: "2" })
		expect(mergeQuery({ a: "1" }, { b: "2" }, false)).toEqual({ a: "1", b: "2" })
	})
})
