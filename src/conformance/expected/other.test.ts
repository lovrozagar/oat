import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { OTHER_EXPECTED } from "./other.ts"

describe("OTHER_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(OTHER_EXPECTED)
	})
})
