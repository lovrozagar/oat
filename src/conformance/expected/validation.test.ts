import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { VALIDATION_EXPECTED } from "./validation.ts"

describe("VALIDATION_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(VALIDATION_EXPECTED)
	})
})
