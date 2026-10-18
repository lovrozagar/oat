import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { CONFORMANCE_EXPECTED } from "./conformance.ts"

describe("CONFORMANCE_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(CONFORMANCE_EXPECTED)).toEqual([])
	})
})
