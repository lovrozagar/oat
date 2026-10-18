import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { WRITE_EXPECTED } from "./write.ts"

describe("WRITE_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(WRITE_EXPECTED)
	})
})
