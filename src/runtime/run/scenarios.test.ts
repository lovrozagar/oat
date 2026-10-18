import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../progress.ts"
import { contextOf, notesApi, optionsFor } from "./__fixtures__/api.ts"
import { scenarios } from "./scenarios.ts"

describe("scenarios", () => {
	it("runs this origin's declared flows as the run's principals, naming the stage", async () => {
		const snaps: ProgressSnapshot[] = []
		const options = optionsFor(notesApi(), {
			onProgress: (snap) => snaps.push(snap),
			scenarios: [{ covers: ["notes.list"], id: "list-notes", steps: [{ operationId: "notes.list" }] }] as never,
		})
		const ctx = await contextOf(options)
		await scenarios(ctx)
		expect(snaps.find((snap) => snap.phase === "scenario")?.message).toBe("1 scenario(s)")
		expect(options.seen.at(-1)).toMatchObject({ method: "GET", path: "/notes" })
		expect(ctx.findings.findings).toEqual([])
	})
})
