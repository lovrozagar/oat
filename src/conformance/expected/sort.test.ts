import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { SORT_EXPECTED } from "./sort.ts"

describe("SORT_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(SORT_EXPECTED)
	})
})
