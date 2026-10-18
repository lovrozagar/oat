import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../spec/graph/types.ts"
import { type Answer, fakeClient, modelOf } from "../checks/__fixtures__/harness.ts"
import { notes } from "./__fixtures__/documents.ts"
import { confirmSubmitted } from "./confirm.ts"

/*
 * An id oat only sent proves nothing: the server may have ignored it. `confirmSubmitted` trusts it
 * only once the entity's read, under that id, returns that id with every scalar field oat sent.
 */

const scope = { projectId: "p1" }
const headers = { authorization: "Bearer alpha" }

function confirm(
	answer: Answer,
	sent: unknown,
	extra: {
		document?: Parameters<typeof notes>[0]
		id?: string
		ignore?: readonly string[]
		readable?: (op: OperationModel) => boolean
		headers?: undefined
	} = {},
) {
	const fake = fakeClient(() => answer)
	const result = confirmSubmitted({
		client: fake.client,
		entity: "note",
		headers: "headers" in extra ? undefined : headers,
		identity: "id",
		model: modelOf(notes(extra.document)),
		scope,
		sent,
		...(extra.id === undefined ? {} : { id: extra.id }),
		...(extra.ignore === undefined ? {} : { ignore: extra.ignore }),
		...(extra.readable === undefined ? {} : { readable: extra.readable }),
	})
	return { result, sent: fake.sent }
}

describe("confirmSubmitted", () => {
	it("returns the read record when it shows the sent id and every sent field", async () => {
		const stored = { createdAt: "2026-10-15", id: "n1", name: "first", size: 3 }
		const { result, sent } = confirm({ body: stored, status: 200 }, { id: "n1", name: "first", size: 3 })
		expect(await result).toEqual(stored)
		expect(sent).toEqual([
			{ method: "GET", options: { headers, operationId: "note.get" }, path: "/projects/p1/notes/n1" },
		])
	})

	it("reads under the id the answer suggested, and without headers when it has none", async () => {
		const stored = { id: "n9", name: "first" }
		const { result, sent } = confirm({ body: stored, status: 200 }, { name: "first" }, { headers: undefined, id: "n9" })
		expect(await result).toEqual(stored)
		expect(sent[0]).toEqual({ method: "GET", options: { operationId: "note.get" }, path: "/projects/p1/notes/n9" })
	})

	it("refuses a read that shows another record's fields under that id", async () => {
		const { result } = confirm(
			{ body: { id: "n1", name: "somebody else's", size: 3 }, status: 200 },
			{
				id: "n1",
				name: "first",
				size: 3,
			},
		)
		expect(await result).toBeNull()
	})

	it("refuses a read that answers with another id, or with no record", async () => {
		expect(
			await confirm({ body: { id: "n2", name: "first" }, status: 200 }, { id: "n1", name: "first" }).result,
		).toBeNull()
		expect(await confirm({ body: [{ id: "n1" }], status: 200 }, { id: "n1", name: "first" }).result).toBeNull()
	})

	it("refuses when the read finds nothing", async () => {
		expect(await confirm({ body: { error: "not found" }, status: 404 }, { id: "n1", name: "first" }).result).toBeNull()
	})
})

describe("confirmSubmitted, without reading", () => {
	it("refuses, without reading, when the entity has no read", async () => {
		const { result, sent } = confirm({ status: 200 }, { id: "n1", name: "first" }, { document: { read: false } })
		expect(await result).toBeNull()
		expect(sent).toEqual([])
	})

	it("refuses, without reading, when the read may not be called", async () => {
		const { result, sent } = confirm({ status: 200 }, { id: "n1", name: "first" }, { readable: () => false })
		expect(await result).toBeNull()
		expect(sent).toEqual([])
	})

	it("refuses, without reading, when the read's path names a value the scope lacks", async () => {
		const document = {
			readOp: { "x-entity": { action: "read", name: "note" } },
			readPath: "/projects/{projectId}/folders/{folderId}/notes/{noteId}",
		}
		const { result, sent } = confirm({ status: 200 }, { id: "n1", name: "first" }, { document })
		expect(await result).toBeNull()
		expect(sent).toEqual([])
	})

	it("refuses, without reading, a body that carries nothing but the id", async () => {
		const { result, sent } = confirm({ body: { id: "n1" }, status: 200 }, { id: "n1" })
		expect(await result).toBeNull()
		expect(sent).toEqual([])
	})

	it("refuses, without reading, a body that is not a plain object or has no scalar id", async () => {
		for (const body of [
			[{ id: "n1", name: "first" }],
			"id=n1&name=first",
			{ id: { value: "n1" }, name: "first" },
			{ name: "first" },
		]) {
			const { result, sent } = confirm({ body: { id: "n1", name: "first" }, status: 200 }, body)
			expect(await result).toBeNull()
			expect(sent).toEqual([])
		}
	})
})

describe("confirmSubmitted, comparing fields", () => {
	it("leaves an ignored field out of the comparison", async () => {
		const stored = { id: "n1", name: "mangled\u0000", size: 3 }
		const sent = { id: "n1", name: "sent\u0000", size: 3 }
		expect(await confirm({ body: stored, status: 200 }, sent, { ignore: ["name"] }).result).toEqual(stored)
		expect(await confirm({ body: stored, status: 200 }, sent).result).toBeNull()
	})

	it("compares a boolean field oat sent", async () => {
		const stored = { done: true, id: "n1" }
		expect(await confirm({ body: stored, status: 200 }, { done: true, id: "n1" }).result).toEqual(stored)
		expect(await confirm({ body: { done: false, id: "n1" }, status: 200 }, { done: true, id: "n1" }).result).toBeNull()
	})

	it("compares a numeric sent id with a string read id as strings", async () => {
		const stored = { id: "7", name: "first" }
		expect(await confirm({ body: stored, status: 200 }, { id: 7, name: "first" }).result).toEqual(stored)
	})
})
