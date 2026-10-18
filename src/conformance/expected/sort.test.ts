import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { SORT_EXPECTED } from "./sort.ts"

describe("SORT_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(SORT_EXPECTED)).toEqual([])
	})
})
