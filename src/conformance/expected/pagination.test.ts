import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { PAGINATION_EXPECTED } from "./pagination.ts"

describe("PAGINATION_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(PAGINATION_EXPECTED)).toEqual([])
	})
})
