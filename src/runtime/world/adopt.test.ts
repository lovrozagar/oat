import { describe, expect, it } from "vitest"
import { fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import { COUNTERS, notes, PAY } from "./__fixtures__/documents.ts"
import { adoptExisting } from "./adopt.ts"

const options = { authHeaders: () => ({}), roots: { projectId: "p1" }, seed: 1 }
const scope = { created: [], values: {} }

describe("adoptExisting", () => {
	it("adopts the first listed record that has an identity", async () => {
		const model = modelOf(notes())
		const { client, sent } = fakeClient(() => ({ body: [{ name: "no id" }, { id: 7 }, { id: "n2" }], status: 200 }))
		expect(await adoptExisting(op(model, "note.create"), { client, model, options }, scope)).toEqual({ id: 7 })
		expect(sent.map((request) => request.path)).toEqual(["/projects/p1/notes"])
	})

	it("reads an entity with no identity of its own by id", async () => {
		const model = modelOf(COUNTERS)
		const { client } = fakeClient(() => ({ body: [{ size: 1 }, { id: "c2" }], status: 200 }))
		expect(await adoptExisting(op(model, "counter.create"), { client, model, options }, scope)).toEqual({ id: "c2" })
	})

	it("is null when no listed record has an identity", async () => {
		const model = modelOf(notes())
		const { client } = fakeClient(() => ({ body: [{ name: "no id" }], status: 200 }))
		expect(await adoptExisting(op(model, "note.create"), { client, model, options }, scope)).toBeNull()
	})

	it("is null, without a request, when there is no entity or no list to adopt from", async () => {
		const { client, sent } = fakeClient(() => ({ body: [{ id: 1 }], status: 200 }))
		const unowned = modelOf(PAY)
		expect(await adoptExisting(op(unowned, "pay.start"), { client, model: unowned, options }, scope)).toBeNull()
		const unlisted = modelOf(notes({ list: false }))
		expect(await adoptExisting(op(unlisted, "note.create"), { client, model: unlisted, options }, scope)).toBeNull()
		expect(sent).toEqual([])
	})
})
