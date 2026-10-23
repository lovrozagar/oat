import { describe, expect, it } from "vitest"
import { didYouMean, nearest } from "./suggest.ts"

describe("nearest", () => {
	it("ranks close candidates by edit distance, then by name, at most three", () => {
		expect(nearest("table.craete", ["table.create", "table.delete", "table.get", "row.list", "zzz"])).toEqual([
			"table.create",
			"table.delete",
			"table.get",
		])
		expect(nearest("jtw", ["jwt", "apiKey"])).toEqual(["jwt"])
		expect(nearest("ab", ["ac", "aa"])).toEqual(["aa", "ac"])
	})

	it("suggests nothing when nothing is close", () => {
		expect(nearest("abcdef", ["zzzzzzzzzzzz"])).toEqual([])
	})
})

describe("didYouMean", () => {
	it("is empty when nothing is close", () => {
		expect(didYouMean("zzzzzz", ["table"])).toBe("")
		expect(didYouMean("tabel", ["table"])).toBe(" Did you mean: table?")
	})
})
