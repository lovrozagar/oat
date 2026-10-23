import { describe, expect, it } from "vitest"
import { NetworkError } from "../../errors/network.ts"
import { disposable, notesClient, notesModel, store, type Store } from "./__fixtures__/notes.ts"
import { leftover } from "./remove.ts"
import type { Disposable, RecordState, TeardownReport } from "./types.ts"
import { STILL_LISTED, STILL_READS, verifyGone } from "./verify-gone.ts"

const petParam = [{ in: "path", name: "pet_id", required: true, schema: { type: "string" } }]
const pet = { "x-entity": { identity: "id", name: "pet" } }

/* Pins list rows with no identity; solos have no list and no read; pets have no list, but a read. */
const model = notesModel("none", {
	"/pets": { post: { operationId: "pets.create", responses: { "201": { description: "made" } }, ...pet } },
	"/pets/{pet_id}": {
		delete: { operationId: "pets.delete", parameters: petParam, responses: { "204": { description: "gone" } }, ...pet },
		get: { operationId: "pets.get", parameters: petParam, responses: { "200": { description: "ok" } }, ...pet },
	},
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

describe("verifyGone for an entity with no list", () => {
	it("reads a removed record with no list back as its creator: a 2xx makes a leftover", async () => {
		const p1 = disposable("pet", "p1")
		const p2 = disposable("pet", "p2", { by: "beta" })
		const held = store({}, { answers: { "GET /pets/p1": { body: { id: "p1" }, status: 200 } } })
		const { records, report, sent } = await relist(held, [p1, p2])
		expect(sent.map((request) => `${request.path} ${JSON.stringify(request.options.as)}`)).toEqual([
			'/pets/p1 {"principal":"alpha"}',
			'/pets/p2 {"principal":"beta"}',
		])
		expect(report.failed).toEqual([leftover(p1, STILL_READS)])
		expect(report.removed).toBe(1)
		expect(records.get(p1)?.removed).toBe(false)
		expect(records.get(p2)?.removed).toBe(true)
	})

	it("takes a 404 or a 410 as gone, and claims nothing from any other answer", async () => {
		const answers = {
			"GET /pets/p1": { status: 404 },
			"GET /pets/p2": { status: 410 },
			"GET /pets/p3": { status: 403 },
		}
		const { report } = await relist(store({}, { answers }), [
			disposable("pet", "p1"),
			disposable("pet", "p2"),
			disposable("pet", "p3"),
		])
		expect(report.failed).toEqual([])
		expect(report.removed).toBe(3)
	})
})

describe("verifyGone reading back a record it cannot reach", () => {
	it("claims nothing when the read cannot be sent", async () => {
		const held = store(
			{},
			{
				answers: {
					"GET /pets/p1": () => {
						throw new NetworkError({
							attempts: 1,
							kind: "dns",
							message: "offline",
							method: "GET",
							url: "http://api.test/",
						})
					},
				},
			},
		)
		const { report } = await relist(held, [disposable("pet", "p1")])
		expect(report.failed).toEqual([])
		expect(report.removed).toBe(1)
	})

	it("lets an error that is not about sending through", async () => {
		const answers = {
			"GET /pets/p1": () => {
				throw new Error("a bug")
			},
		}
		await expect(relist(store({}, { answers }), [disposable("pet", "p1")])).rejects.toThrow("a bug")
	})
})
