import { existsSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { EXIT } from "../../src/runtime/exit.ts"
import { latestJournal, latestReport, oat, referenceConfig, tempDirs } from "../support/cli-run.ts"

/*
 * A profile gates which operations a run may touch. An excluded operation is never sent and never
 * reads as passed: the run names it as a coverage gap and lists it in the report. `cheap` also
 * turns the exchange journal off unless asked for.
 */

const dirs = tempDirs("oat-profiles-")
afterAll(dirs.removeAll)

/* A profile of the config's own that keeps a run off the table update. */
const PROFILES = { profiles: { gentle: { exclude: ["table.update"] } } }

/* `oat run <flags>` against a clean reference, with `extra` in the config; `runs` is its --out. */
async function runWith(extra: Record<string, unknown>, flags: string[]) {
	const server = await createMemoryServer({})
	try {
		const dir = await dirs.make()
		const config = await referenceConfig(dir, server.url, extra)
		const runs = join(dir, "runs")
		const { code, out } = await oat(["run", "--config", config, "--out", runs, "--quiet", ...flags])
		return { code, runs, text: out }
	} finally {
		await server.close()
	}
}

describe("a profile the config defines and selects", () => {
	it("never sends the operation it excludes, and names it as a gap", async () => {
		const { code, runs, text } = await runWith({ ...PROFILES, profile: "gentle" }, ["--only", "table"])
		expect(code).toBe(EXIT.clean)
		expect(text).toContain("skipped 1 operation(s) under --profile gentle (1 excluded by name)")
		expect(text).toContain('table.update excluded by profile "gentle"')
		const report = await latestReport(runs)
		expect(report.profile).toBe("gentle")
		expect(report.profileExclusions).toEqual([
			{ entity: "table", operationId: "table.update", reason: "excluded by name (operationId: table.update)" },
		])
		expect(report.findings).toContainEqual(
			expect.objectContaining({ check: "profile.skip", entity: "table", verdict: "COVERAGE_GAP" }),
		)
		expect(report.scope.operations.map((op) => op.operationId)).not.toContain("table.update")
		expect((await latestJournal(runs)).filter((line) => line.operationId === "table.update")).toEqual([])
	}, 60_000)

	it("refuses, exit 2, an exact target the profile excludes", async () => {
		const { code, text } = await runWith(PROFILES, ["--profile", "gentle", "--ops", "table.update"])
		expect(code).toBe(EXIT.usage)
		expect(text).toContain("table.update")
	}, 60_000)
})

describe("--profile", () => {
	it("cheap runs without the exchange journal and says so in the report", async () => {
		const { code, runs } = await runWith({}, ["--only", "table", "--profile", "cheap"])
		expect(code).toBe(EXIT.clean)
		expect((await latestReport(runs)).profile).toBe("cheap")
		expect(existsSync(join(runs, "latest", "exchanges.jsonl"))).toBe(false)
	}, 60_000)

	it("refuses, exit 2, a name neither built in nor configured, listing the known ones", async () => {
		const { code, text } = await runWith(PROFILES, ["--profile", "gentel"])
		expect(code).toBe(EXIT.usage)
		expect(text).toContain('profile "gentel" is not defined. Known: cheap, full, gentle')
	})
})
