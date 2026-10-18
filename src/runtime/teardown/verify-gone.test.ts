import { describe, expect, it } from "vitest"
import { disposable, notesClient, notesModel, store, type Store } from "./__fixtures__/notes.ts"
import { leftover } from "./remove.ts"
import type { Disposable, RecordState, TeardownReport } from "./types.ts"
import { STILL_LISTED, verifyGone } from "./verify-gone.ts"

/* Pins list rows with no identity; solos have no list at all. */
const model = notesModel("none", {
	"/pins": {
		get: {
			operationId: "pins.list",
			responses: { "200": { description: "ok" } },
			"x-entity": { action: "list", name: "pin" },
		},
	},
	"/solos/{solo_id}": {
		delete: {
			operationId: "solos.delete",
			parameters: [{ in: "path", name: "solo_id", required: true, schema: { type: "string" } }],
			responses: { "204": { description: "gone" } },
			"x-entity": { action: "delete", identity: "id", name: "solo" },
		},
	},
})

/** Re-lists the removed `items` (the others left in place) against `held`. */
async function relist(held: Store, removed: Disposable[], kept: Disposable[] = []) {
	const records = new Map<Disposable, RecordState>()
	for (const item of [...removed, ...kept]) {
		records.set(item, { entity: item.entity, id: item.id, principal: item.owner.id, removed: removed.includes(item) })
	}
	const report: TeardownReport = { failed: [], records: [], removed: removed.length, unidentified: [], unsupported: [] }
	const { client, sent } = notesClient(held)
	await verifyGone({ client, model, queue: [...removed, ...kept], records, report })
	return { records, report, sent }
}

describe("verifyGone", () => {
	it("makes a leftover of a removed record its list still holds", async () => {
		const n1 = disposable("note", "n1")
		const n2 = disposable("note", "n2")
		const { records, report, sent } = await relist(store({ alpha: ["n1"] }), [n1, n2])
		expect(sent).toHaveLength(1)
		expect(report.failed).toEqual([leftover(n1, STILL_LISTED)])
		expect(report.removed).toBe(1)
		expect(records.get(n1)?.removed).toBe(false)
	})

	it("reads each creator's list once", async () => {
		const { sent } = await relist(store(), [
			disposable("note", "n1"),
			disposable("note", "n2"),
			disposable("note", "n3", { by: "beta" }),
		])
		expect(sent.map((request) => request.path)).toEqual(["/notes", "/notes"])
	})

	it("reads nothing for a record kept, unlisted, listed without identity, or under a list it cannot fill", async () => {
		const { sent } = await relist(
			store(),
			[disposable("ghost", "g1"), disposable("solo", "s1"), disposable("pin", "p1"), disposable("comment", "c1")],
			[disposable("note", "n1")],
		)
		expect(sent).toEqual([])
	})

	it("claims nothing when the list is refused", async () => {
		const { report } = await relist(store({}, { answers: { "GET /notes": { status: 401 } } }), [
			disposable("note", "n1"),
		])
		expect(report.failed).toEqual([])
		expect(report.removed).toBe(1)
	})
})
