import { describe, expect, it } from "vitest"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { listedIds, type ProvenId } from "../proven-id.ts"
import { notesClient, notesModel, owner, store } from "./__fixtures__/notes.ts"
import { Ledger } from "./ledger.ts"

/* An id as a listing gave it back. */
function id(value: string): ProvenId {
	const [proven] = listedIds([value])
	if (proven === undefined) throw new Error(`no id from ${value}`)
	return proven
}

describe("Ledger: recording", () => {
	it("records each record once per creator, and never an empty id", () => {
		const ledger = new Ledger()
		ledger.record({ entity: "note", id: id("n1"), scope: { org: "o1" } }, owner("alpha"))
		ledger.record({ entity: "note", id: id("n1"), scope: {} }, owner("alpha"))
		ledger.record({ entity: "note", id: id("n1"), scope: {} }, owner("beta"))
		ledger.record({ entity: "note", id: id(""), scope: {} }, owner("alpha"))
		ledger.record({ entity: "note", id: id("undefined"), scope: {} }, owner("alpha"))
		expect(ledger.size).toBe(2)
		expect(ledger.recorded).toBe(2)
		expect(ledger.entries().map((item) => `${item.id} ${item.owner.id}`)).toEqual(["n1 alpha", "n1 beta"])
		expect(ledger.entries()[0]?.scope).toEqual({ org: "o1" })
	})

	it("keeps an inferred record's mark, and says which records it holds whoever made them", () => {
		const ledger = new Ledger()
		ledger.record({ entity: "job", id: id("j1"), inferred: true, scope: {} }, owner("beta"))
		expect(ledger.entries()).toEqual([{ entity: "job", id: "j1", inferred: true, owner: owner("beta"), scope: {} }])
		expect(ledger.holds("job", "j1")).toBe(true)
		expect(ledger.holds("job", "j2")).toBe(false)
		expect(ledger.holds("note", "j1")).toBe(false)
	})

	it("reports each unidentified create once, in the order it was sent", () => {
		const ledger = new Ledger()
		const second = exchange("POST", "/notes", { status: 201 })
		const first = { ...exchange("POST", "/notes", { status: 201 }), seq: second.seq - 1 }
		ledger.unidentified("note", "notes.create", second)
		ledger.unidentified("note", "notes.create", first)
		ledger.unidentified("note", "notes.create", second)
		expect(ledger.unidentifiedCreates.map((create) => create.seq)).toEqual([first.seq, second.seq])
		expect(ledger.unidentifiedCreates[0]).toEqual({
			entity: "note",
			method: "POST",
			operationId: "notes.create",
			seq: first.seq,
			status: 201,
			url: "http://api.test/notes",
		})
	})
})

describe("Ledger: unwinding", () => {
	it("removes what was recorded, then only what was recorded since", async () => {
		const ledger = new Ledger()
		ledger.record({ entity: "note", id: id("n1"), scope: {} }, owner("alpha"))
		ledger.sighted("note", "n1", "alpha")
		const { client, sent } = notesClient(store({ alpha: ["n1", "n2"] }))
		const first = await ledger.unwind(notesModel(), client, { fallbacks: () => [] })
		expect(first.removed).toBe(1)
		expect(ledger.size).toBe(0)
		ledger.record({ entity: "note", id: id("n2"), scope: {} }, owner("alpha"))
		const second = await ledger.unwind(notesModel(), client, { fallbacks: () => [], options: { verify: false } })
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
			"DELETE /notes/n1",
			"GET /notes",
			"GET /notes/n2",
			"DELETE /notes/n2",
		])
		expect(second.removed).toBe(1)
	})

	it("does not take its creator's 404 for a record a write moved away", async () => {
		const ledger = new Ledger()
		ledger.record({ entity: "note", id: id("n1"), scope: {} }, owner("alpha"))
		ledger.sighted("note", "n1", "alpha")
		ledger.moved("note", "n1", "PATCH moved it to tenant t2")
		const { client } = notesClient(store())
		const report = await ledger.unwind(notesModel(), client, { fallbacks: () => [] })
		expect(report.failed.map((entry) => entry.reason)).toEqual([
			"PATCH moved it to tenant t2; DELETE /notes/n1 returned alpha: 404",
		])
	})
})
