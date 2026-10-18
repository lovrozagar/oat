import { describe, expect, it } from "vitest"
import type { Client } from "../../client/client.ts"
import { fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import { FencedError } from "../fence.ts"
import { notes } from "./__fixtures__/documents.ts"
import { listExisting } from "./list-existing.ts"

/* A client whose every read fails with `error`. */
const failing = (error: Error): Client =>
	({
		get: async () => {
			throw error
		},
	}) as unknown as Client

const model = modelOf(notes())
const route = (values: Record<string, string>) => ({ listOp: op(model, "note.list"), model, values })

describe("listExisting", () => {
	it("reads what the list already returns, asking for its largest page", async () => {
		const { client, sent } = fakeClient(() => ({ body: [{ id: "n1" }], status: 200 }))
		expect(await listExisting(route({ projectId: "p1" }), client, { authorization: "a" })).toEqual([{ id: "n1" }])
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /projects/p1/notes"])
		expect(sent[0]?.options.operationId).toBe("note.list")
	})

	it("is empty when the route cannot be filled or the list refuses", async () => {
		const { client, sent } = fakeClient(() => ({ status: 403 }))
		expect(await listExisting(route({}), client, {})).toEqual([])
		expect(sent).toEqual([])
		expect(await listExisting(route({ projectId: "p1" }), client, {})).toEqual([])
	})

	it("is empty when the read fails, but a fenced read is not an empty collection", async () => {
		expect(await listExisting(route({ projectId: "p1" }), failing(new Error("reset")), {})).toEqual([])
		const fenced = new FencedError({ method: "GET", phase: "seed", reason: "not allowed", url: "/projects/p1/notes" })
		await expect(listExisting(route({ projectId: "p1" }), failing(fenced), {})).rejects.toBe(fenced)
	})
})
