import { describe, expect, it } from "vitest"
import { familyProblems } from "./__fixtures__/family.ts"
import { ISOLATION_EXPECTED } from "./isolation.ts"

describe("ISOLATION_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expect(familyProblems(ISOLATION_EXPECTED)).toEqual([])
	})
})
