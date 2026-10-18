import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runTask } from "./tasks.ts"

/*
 * A task's answer carries what its worker held afterwards, and with OAT_HEAP_SNAPSHOTS set, a heap
 * snapshot after each task: how a leg's leftovers are found. The other kinds start reference
 * servers and are covered where sockets are allowed.
 */

const nothing = { defects: ["NO_SUCH_DEFECT"], kind: "scope", known: {} } as const

afterEach(() => {
	delete process.env.OAT_HEAP_SNAPSHOTS
})

describe("runTask", () => {
	it("answers with what the process holds after the task", async () => {
		const answer = await runTask({ ...nothing, defects: [...nothing.defects] }, 1)
		expect(answer).toMatchObject({ kind: "results", results: [] })
		expect(answer.memory.rss).toBeGreaterThan(answer.memory.heapUsed)
	})

	it("writes a heap snapshot after the task when asked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oat-heap-"))
		process.env.OAT_HEAP_SNAPSHOTS = dir
		await runTask({ ...nothing, defects: [...nothing.defects] }, 7)
		expect(readdirSync(dir)).toEqual([expect.stringMatching(/^\d+-0007-scope\.heapsnapshot$/)])
	}, 60_000)
})
