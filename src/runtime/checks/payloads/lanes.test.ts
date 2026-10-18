import { describe, expect, it } from "vitest"
import { payloadLanes } from "./lanes.ts"

/*
 * `payload.string-survives` fans its cases across lanes that run together. Written through an
 * update, every lane needs a record of its own: two lanes sharing one read back each other's values
 * and call a correct backend corrupt. When some lane records could not be made, there are fewer
 * lanes, never shared records. Through create, every case is a record of its own.
 */

describe("payloadLanes", () => {
	it("runs no more update lanes than there are records to write", () => {
		expect(payloadLanes({ cases: 30, max: 4, records: 1, viaPatch: true })).toBe(1)
		expect(payloadLanes({ cases: 30, max: 4, records: 3, viaPatch: true })).toBe(3)
		expect(payloadLanes({ cases: 30, max: 4, records: 4, viaPatch: true })).toBe(4)
	})

	it("is bounded by the cases and the cap", () => {
		expect(payloadLanes({ cases: 2, max: 4, records: 4, viaPatch: true })).toBe(2)
		expect(payloadLanes({ cases: 30, max: 4, records: 1, viaPatch: false })).toBe(4)
		expect(payloadLanes({ cases: 0, max: 4, records: 1, viaPatch: false })).toBe(1)
	})
})
