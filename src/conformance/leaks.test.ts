import { describe, expect, it } from "vitest"
import { damagedBystanders, ledgeredNotCreated, unreportedLeftovers } from "./leaks.ts"
import type { TeardownReport } from "../runtime/teardown.ts"
import { DAMAGES_BYSTANDERS } from "../reference/defects.ts"
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

/*
 * Two rules every conformance case is held to, beside "leaves nothing behind": oat never deletes
 * or changes a record it did not create, and every id it ledgered for teardown is one the backend
 * created during the run. The second is what an id oat merely sent breaks.
 */

describe("damagedBystanders", () => {
	const before = {
		table: [
			{ deleted_at: null, id: "t1", name: "kept" },
			{ deleted_at: null, id: "t2", name: "renamed" },
			{ deleted_at: null, id: "t3", name: "removed" },
			{ deleted_at: null, id: "t4", name: "tombstoned" },
		],
	}

	it("names a pre-existing record that was deleted, changed or tombstoned", () => {
		const after = {
			table: [
				{ deleted_at: null, id: "t1", name: "kept" },
				{ deleted_at: null, id: "t2", name: "something else" },
				{ deleted_at: "2026-10-15T00:00:00Z", id: "t4", name: "tombstoned" },
			],
		}
		expect(damagedBystanders(before, after)).toEqual([
			"table t2 changed name",
			"table t3 deleted",
			"table t4 changed deleted_at",
		])
	})

	it("is empty when every pre-existing record is untouched, whatever the run added", () => {
		const after = { table: [...before.table, { deleted_at: null, id: "t9", name: "made by the run" }] }
		expect(damagedBystanders(before, after)).toEqual([])
	})

	it("compares ids across number and string forms", () => {
		expect(damagedBystanders({ row: [{ id: 7, v: 1 }] }, { row: [{ id: 7, v: 1 }] })).toEqual([])
		expect(damagedBystanders({ row: [{ id: 7, v: 1 }] }, { row: [] })).toEqual(["row 7 deleted"])
	})
})

describe("ledgeredNotCreated", () => {
	const created = { note: ["n1", "n2"], tag: ["g1"] }

	it("names every ledgered id the backend never created", () => {
		const records = [
			{ entity: "note", id: "n1" },
			{ entity: "note", id: "n9" },
			{ entity: "tag", id: "n2" },
			{ entity: "label", id: "g1" },
		]
		expect(ledgeredNotCreated(records, created)).toEqual(["note n9", "tag n2", "label g1"])
	})

	it("is empty when every ledgered id was created", () => {
		expect(
			ledgeredNotCreated(
				[
					{ entity: "note", id: "n2" },
					{ entity: "tag", id: "g1" },
				],
				created,
			),
		).toEqual([])
	})
})

describe("DAMAGES_BYSTANDERS", () => {
	it("excuses no defect today: every case is held to the bystander rule", () => {
		expect([...DAMAGES_BYSTANDERS]).toEqual([])
	})
})
