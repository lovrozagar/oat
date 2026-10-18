import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { PAGINATION_EXPECTED } from "./pagination.ts"

describe("PAGINATION_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(PAGINATION_EXPECTED)
	})
})
