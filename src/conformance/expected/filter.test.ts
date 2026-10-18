import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { FILTER_EXPECTED } from "./filter.ts"

describe("FILTER_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(FILTER_EXPECTED)
	})
})
