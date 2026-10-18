import { describe, expect, it } from "vitest"
import { referenceModel } from "./__fixtures__/models.ts"
import { didYouMean, matchPattern } from "./match.ts"
import { ScopeError } from "./scope-error.ts"

const model = referenceModel()

describe("matchPattern", () => {
	it("matches an exact operationId outright", () => {
		expect(matchPattern("table.get", model, "table.get")).toEqual({ exact: true, ids: ["table.get"] })
	})

	it("expands a glob within an operationId, escaping everything else", () => {
		expect(matchPattern("row.*", model, "row.*").ids.sort()).toEqual([
			"row.create",
			"row.delete",
			"row.get",
			"row.list",
			"row.update",
		])
		expect(matchPattern("row.*", model, "row.*").exact).toBe(false)
		expect(() => matchPattern("row?*", model, "row?*")).toThrow(ScopeError)
	})

	it("refuses a pattern that matches nothing, suggesting the nearest for an exact one", () => {
		expect(() => matchPattern("table.craete", model, "cdn:table.craete")).toThrow(
			'oat: --ops "cdn:table.craete" matches no operation. Did you mean: table.create, table.delete, table.get?',
		)
		expect(() => matchPattern("zzzzzz", model, "zzzzzz")).toThrow('oat: --ops "zzzzzz" matches no operation.')
		expect(() => matchPattern("nothing.*", model, "nothing.*")).toThrow('oat: --ops "nothing.*" matches no operation.')
	})
})

describe("didYouMean", () => {
	it("is empty when nothing is close", () => {
		expect(didYouMean("zzzzzz", ["table"])).toBe("")
		expect(didYouMean("tabel", ["table"])).toBe(" Did you mean: table?")
	})
})
