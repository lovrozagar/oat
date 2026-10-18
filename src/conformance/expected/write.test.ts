import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { WRITE_EXPECTED } from "./write.ts"

describe("WRITE_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(WRITE_EXPECTED)).toEqual([])
	})
})
