import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { leftBehind } from "../../src/conformance/leaks.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"
import { EXIT } from "../../src/runtime/exit.ts"
import { latestJournal, latestReport, oat, referenceConfig, tempDirs } from "../support/cli-run.ts"

/*
 * `--keep-fixtures` leaves what a run created in place, so a failing exchange can be replayed
 * against the same rows. The next run against that backend works beside them: it grades as before
 * and removes only what it made itself, never the rows the earlier run kept.
 */

const dirs = tempDirs("oat-keep-fixtures-")
const servers: ReferenceServer[] = []
afterAll(async () => {
	await Promise.all(servers.map((server) => server.close()))
	await dirs.removeAll()
})

/* `oat run --only table <flags>` against `server`; `runs` is its --out. */
async function runOn(server: ReferenceServer, flags: string[] = []) {
	const dir = await dirs.make()
	const config = await referenceConfig(dir, server.url)
	const runs = join(dir, "runs")
	const { code, out } = await oat(["run", "--config", config, "--out", runs, "--only", "table", "--quiet", ...flags])
	return { code, runs, text: out }
}

describe("--keep-fixtures", () => {
	it("leaves what the run made, and the next run works beside it and removes only its own", async () => {
		const server = await createMemoryServer({})
		servers.push(server)
		const empty = await server.snapshot()

		const kept = await runOn(server, ["--keep-fixtures"])
		expect(kept.code).toBe(EXIT.clean)
		/* Nothing was torn down, so nothing reads as cleaned up. */
		expect(kept.text).not.toContain("cleaned up")
		expect(kept.text).toMatch(/left \d+ created record\(s\) in place: teardown did not run/)
		expect((await latestReport(kept.runs)).teardown).toBeUndefined()
		expect((await latestJournal(kept.runs)).filter((line) => line.phase === "teardown")).toEqual([])
		const afterKept = await server.snapshot()
		const left = leftBehind(empty, afterKept)
		expect(left.length).toBeGreaterThan(0)

		const next = await runOn(server)
		expect(next.code).toBe(EXIT.clean)
		expect(next.text).toMatch(/cleaned up (\d+)\/\1 created record\(s\)/)
		const report = await latestReport(next.runs)
		expect(report.teardown?.failed).toEqual([])
		expect(report.teardown?.records.every((record) => record.removed)).toBe(true)
		/* The kept rows are still there, and nothing of the second run's is. */
		const afterNext = await server.snapshot()
		expect(leftBehind(empty, afterNext)).toEqual(left)
		expect(leftBehind(afterKept, afterNext)).toEqual([])
	}, 60_000)
})
