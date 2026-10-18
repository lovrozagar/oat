import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../progress.ts"
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
