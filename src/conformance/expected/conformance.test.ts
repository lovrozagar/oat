import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { CONFORMANCE_EXPECTED } from "./conformance.ts"

describe("CONFORMANCE_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(CONFORMANCE_EXPECTED)
	})
})
