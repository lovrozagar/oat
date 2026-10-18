import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { CONSISTENCY_EXPECTED } from "./consistency.ts"

describe("CONSISTENCY_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(CONSISTENCY_EXPECTED)).toEqual([])
	})
})
