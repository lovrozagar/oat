import { describe, expect, it } from "vitest"
import { exchangeOf } from "../checks/__fixtures__/harness.ts"
import { listedIds } from "../proven-id.ts"
import { owner } from "../teardown/__fixtures__/notes.ts"
import type { ProgressSnapshot } from "../progress/types.ts"
import { contextOf, notesApi, optionsFor } from "./__fixtures__/api.ts"
import { contractFloor } from "./contract-floor.ts"

describe("contractFloor", () => {
	it("proves from the transcript, then calls each operation nothing else reached", async () => {
		const snaps: ProgressSnapshot[] = []
		const options = optionsFor(notesApi(), { onProgress: (snap) => snaps.push(snap) })
		const ctx = await contextOf(options)
		await contractFloor(ctx)
		const messages = snaps.flatMap((snap) => snap.message ?? [])
		expect(messages.slice(-2)).toEqual(["evidence from the transcript", "operations no check or scenario reached"])
		expect(ctx.state.checksRun.has("response.contract-call")).toBe(true)
		expect(options.seen.some((request) => request.method === "GET" && request.path === "/notes")).toBe(true)
	})

	it("calls only targeted operations in a targeted run", async () => {
		const options = optionsFor(notesApi(), { ops: ["notes.list"] })
		const ctx = await contextOf(options)
		await contractFloor(ctx)
		expect(options.seen.some((request) => request.method === "POST")).toBe(false)
	})
})

/* A list that showed one note under `note_id`. */
const seen = (noteId: string) =>
	exchangeOf(
		{ method: "GET", options: { as: { anonymous: true }, operationId: "notes.list" }, path: "/notes" },
		{ body: [{ note_id: noteId }], status: 200 },
	)

describe("contractFloor and writes", () => {
	it("sends a write only to a record the run ledgered, never to a newer one it merely saw", async () => {
		const options = optionsFor(notesApi(), { ops: ["notes.delete"] })
		const ctx = await contextOf(options)
		ctx.client.transcript.push(seen("n-made"), seen("n-foreign"))
		const [made] = listedIds(["n-made"])
		if (made === undefined) throw new Error("no id")
		ctx.ledger.record({ entity: "note", id: made, scope: {} }, owner("alpha"))
		await contractFloor(ctx)
		const deletes = options.seen.filter((request) => request.method === "DELETE").map((request) => request.path)
		expect(deletes).toEqual(["/notes/n-made"])
	})
})
