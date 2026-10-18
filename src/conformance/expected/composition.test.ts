import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { COMPOSITION_EXPECTED } from "./composition.ts"

describe("COMPOSITION_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(COMPOSITION_EXPECTED)).toEqual([])
	})
})
