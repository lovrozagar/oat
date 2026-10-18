import { describe, it } from "vitest"
import { expectFamily } from "./__fixtures__/family.ts"
import { ISOLATION_EXPECTED } from "./isolation.ts"

describe("ISOLATION_EXPECTED", () => {
	it("names registered checks for real defects, carried into the table", () => {
		expectFamily(ISOLATION_EXPECTED)
	})
})
