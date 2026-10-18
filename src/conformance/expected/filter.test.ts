import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { FILTER_EXPECTED } from "./filter.ts"

describe("FILTER_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(FILTER_EXPECTED)).toEqual([])
	})
})
