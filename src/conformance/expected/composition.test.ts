import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { COMPOSITION_EXPECTED } from "./composition.ts"

describe("COMPOSITION_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(COMPOSITION_EXPECTED)
	})
})
