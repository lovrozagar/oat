import { describe, expect, it } from "vitest"
import { degradedWorld } from "./state.ts"

describe("degradedWorld", () => {
	it("is a world of records oat did not create", () => {
		expect(degradedWorld({ records: [{ id: "a" }], scope: { org: "o" } })).toEqual({
			createAcknowledged: false,
			degraded: true,
			records: [{ id: "a" }],
			scope: { created: [], values: { org: "o" } },
			uniqueAdopted: false,
		})
	})
})
