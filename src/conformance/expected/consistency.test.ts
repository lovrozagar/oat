import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { CONSISTENCY_EXPECTED } from "./consistency.ts"

describe("CONSISTENCY_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(CONSISTENCY_EXPECTED)
	})
})
