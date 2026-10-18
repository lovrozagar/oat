import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { OTHER_EXPECTED } from "./other.ts"

describe("OTHER_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(OTHER_EXPECTED)).toEqual([])
	})
})
