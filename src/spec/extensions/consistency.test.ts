import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { readConsistency } from "./consistency.ts"

const op = (tags: Record<string, unknown>) => tags as OperationObject

describe("x-consistency", () => {
	it("is null when the read declares nothing", () => {
		expect(readConsistency(op({}))).toBeNull()
		expect(readConsistency(op({ "x-consistency": "30s" }))).toBeNull()
	})

	it("reads the staleness bound in milliseconds and the bypass header, its name lowercased", () => {
		expect(readConsistency(op({ "x-consistency": { bypass: "X-Fresh: 1", staleness: "30s" } }))).toEqual({
			bypass: { name: "x-fresh", value: "1" },
			stalenessMs: 30_000,
		})
	})

	it("keeps a value with a colon of its own whole", () => {
		expect(readConsistency(op({ "x-consistency": { bypass: "x-at: 12:00" } }))?.bypass).toEqual({
			name: "x-at",
			value: "12:00",
		})
	})

	it("drops a field it cannot read and keeps the other", () => {
		expect(readConsistency(op({ "x-consistency": { bypass: "no-colon", staleness: "30s" } }))).toEqual({
			bypass: null,
			stalenessMs: 30_000,
		})
		for (const staleness of ["30", "1.5s", "-1s", "30ms", 30]) {
			expect(readConsistency(op({ "x-consistency": { bypass: "x-fresh: 1", staleness } }))).toEqual({
				bypass: { name: "x-fresh", value: "1" },
				stalenessMs: null,
			})
		}
	})

	it("is null when neither field is readable", () => {
		expect(readConsistency(op({ "x-consistency": { bypass: ": 1", staleness: "soon" } }))).toBeNull()
	})
})
