import { describe, expect, it } from "vitest"
import { unreportedLeftovers } from "../src/conformance/leaks.ts"
import type { TeardownReport } from "../src/runtime/teardown.ts"

/*
 * A record left behind is a fault in oat unless oat said so: teardown names it as failed, or a
 * create oat could not identify accounts for it. Anything else left in the backend is silent litter.
 */

const report = (over: Partial<TeardownReport>): TeardownReport => ({
	failed: [],
	records: [],
	removed: 0,
	unidentified: [],
	unsupported: [],
	...over,
})
const unknown = (entity: string, seq: number) => ({
	entity,
	method: "POST",
	operationId: `${entity}.create`,
	seq,
	status: 201,
	url: `http://x/${entity}s`,
})

describe("unreportedLeftovers", () => {
	it("is every row left behind when teardown said nothing", () => {
		expect(unreportedLeftovers(["row r1", "table t1"], report({}))).toEqual(["row r1", "table t1"])
		expect(unreportedLeftovers(["row r1"], null)).toEqual(["row r1"])
	})

	it("leaves out a row teardown names as failed, by entity and id", () => {
		const named = report({ failed: [{ entity: "row", id: "r1", principal: "beta", reason: "DELETE returned 403" }] })
		expect(unreportedLeftovers(["row r1", "row r2", "table r1"], named)).toEqual(["row r2", "table r1"])
	})

	it("covers rows of an entity by as many unidentified creates as it reported", () => {
		const covered = report({ unidentified: [unknown("row", 3), unknown("row", 9)] })
		expect(unreportedLeftovers(["row r1", "row r2", "row r3", "table t1"], covered)).toEqual(["row r3", "table t1"])
	})

	it("is empty when nothing was left behind", () => {
		expect(unreportedLeftovers([], report({ unidentified: [unknown("row", 1)] }))).toEqual([])
	})
})
