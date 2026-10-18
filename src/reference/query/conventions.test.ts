import { describe, expect, it } from "vitest"
import { DEFAULT_CONVENTIONS, SEARCH_MODES } from "./conventions.ts"

describe("query conventions", () => {
	it("search by substring or by prefix", () => {
		expect(SEARCH_MODES).toEqual(["contains", "prefix"])
	})

	it("default to binary text, nulls first ascending, and lenient filter values", () => {
		expect(DEFAULT_CONVENTIONS).toEqual({ collation: "binary", nulls: "first", strictTypes: false })
	})
})
