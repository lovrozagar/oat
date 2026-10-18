import { describe, expect, it } from "vitest"
import { mergeQuery } from "./query.ts"

describe("mergeQuery", () => {
	it("lets the later value win when the grammar does not repeat", () => {
		expect(mergeQuery({ filter: "a", limit: "5" }, { filter: "b" }, false)).toEqual({ filter: "b", limit: "5" })
	})

	it("sends both values of a key both sides carry when the grammar repeats", () => {
		expect(mergeQuery({ filter: "a", limit: "5" }, { filter: ["b", "c"], order: "id" }, true)).toEqual({
			filter: ["a", "b", "c"],
			limit: "5",
			order: "id",
		})
		expect(mergeQuery({ filter: ["a"] }, { filter: "b" }, true)).toEqual({ filter: ["a", "b"] })
	})
})
