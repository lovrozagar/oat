import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../../runtime/progress/types.ts"
import { bufferWriter } from "../writer.ts"
import { folder } from "../__fixtures__/files.ts"
import { runProgress } from "./run-progress.ts"

/*
 * The run's live status: a line on stderr unless quiet, every move in three files, and
 * progress.json for what is happening now — rewritten at most once a second, and at the end.
 */

const snap = (extra: Partial<ProgressSnapshot>): ProgressSnapshot => ({
	elapsedMs: 1,
	findings: 0,
	phase: "load",
	requests: 0,
	...extra,
})

async function closed(progress: ReturnType<typeof runProgress>): Promise<void> {
	await progress.close()
}

describe("runProgress closing", () => {
	it("resolves close once every file is written and shut, so the folder can be removed at once", async () => {
		const dir = folder()
		const progress = runProgress(bufferWriter(), dir, { quiet: true, startedAt: Date.now() })
		progress.onProgress(snap({ message: "openapi.json" }))
		await progress.close()
		expect(readFileSync(join(dir, "progress.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
		expect(readFileSync(join(dir, "progress.tsv"), "utf8").split("\n")[0]).toContain("\t")
	})
})

describe("runProgress", () => {
	it("writes every move to the run folder and the terminal", async () => {
		const dir = folder()
		const writer = bufferWriter()
		const progress = runProgress(writer, dir, { quiet: false, startedAt: Date.now() })
		progress.onProgress(snap({ message: "openapi.json" }))
		progress.onProgress(snap({ entity: "note", phase: "seed" }))
		await closed(progress)
		const log = readFileSync(join(dir, "progress.log"), "utf8")
		expect(log.split("\n").length).toBeGreaterThan(3)
		expect(readFileSync(join(dir, "progress.tsv"), "utf8").split("\n")[0]).toContain("\t")
		expect(readFileSync(join(dir, "progress.jsonl"), "utf8").trim().split("\n")).toHaveLength(2)
		expect(writer.text()).toContain("seed")
	})

	it("keeps the terminal quiet when asked", async () => {
		const writer = bufferWriter()
		const progress = runProgress(writer, folder(), { quiet: true, startedAt: Date.now() })
		progress.onProgress(snap({}))
		await closed(progress)
		expect(writer.text()).toBe("")
	})

	it("rewrites progress.json at most once a second, and at the end, with how long since the last answer", async () => {
		const dir = folder()
		const progress = runProgress(bufferWriter(), dir, { quiet: true, startedAt: Date.now() })
		const read = () =>
			JSON.parse(readFileSync(join(dir, "progress.json"), "utf8")) as ProgressSnapshot & { lastAgoMs: number | null }
		progress.onProgress(snap({ message: "first" }))
		expect(read()).toMatchObject({ lastAgoMs: null, message: "first" })
		progress.onProgress(snap({ entity: "note", message: "too soon", phase: "seed" }))
		expect(read().message).toBe("first")
		const at = Date.now() - 5_000
		progress.onProgress(
			snap({
				last: {
					at,
					durationMs: 1,
					method: "GET",
					requestBytes: 0,
					requestId: "",
					responseBytes: 0,
					status: 200,
					url: "u",
				},
				phase: "done",
			}),
		)
		expect(read().lastAgoMs).toBeGreaterThanOrEqual(5_000)
		progress.onProgress(snap({ inflight: { at: Date.now(), method: "GET", url: "u" }, phase: "done" }))
		expect(read().lastAgoMs).toBeLessThan(1_000)
		await closed(progress)
	})
})
