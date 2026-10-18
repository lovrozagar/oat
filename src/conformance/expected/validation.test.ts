import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { VALIDATION_EXPECTED } from "./validation.ts"

describe("VALIDATION_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(VALIDATION_EXPECTED)).toEqual([])
	})
})
