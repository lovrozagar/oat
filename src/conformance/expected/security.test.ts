import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { SECURITY_EXPECTED } from "./security.ts"

describe("SECURITY_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(SECURITY_EXPECTED)).toEqual([])
	})
})
