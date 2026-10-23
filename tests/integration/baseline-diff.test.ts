import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { EXIT } from "../../src/runtime/exit.ts"
import { latestReport, oat, referenceConfig, tempDirs } from "../support/cli-run.ts"

/*
 * The loop a team runs against a backend with known defects: run, write a baseline from that run,
 * run again after the backend changed, and diff the two runs. The baseline keeps known findings out
 * of the exit code; the diff names what is new, fixed and persisting, and is never a gate.
 */

const dirs = tempDirs("oat-baseline-diff-")
afterAll(dirs.removeAll)

const FILTER = "filter.unknown-field-rejected"
const LIMIT = "pagination.limit-bounds-page-size"

/* `oat run --only table` against a reference with `defects`; returns the exit, output and run folder. */
async function runAgainst(dir: string, defects: string[], extra: Record<string, unknown> = {}) {
	const server = await createMemoryServer({ defects })
	try {
		const config = await referenceConfig(dir, server.url, extra)
		const out = join(dir, "runs")
		const { code, out: text } = await oat(["run", "--config", config, "--out", out, "--only", "table", "--quiet"])
		return { code, out, run: join(out, "latest"), text }
	} finally {
		await server.close()
	}
}

describe("run, baseline, run again, diff", () => {
	it("excuses the known finding, fails on the new one, and diffs the two runs", async () => {
		const root = await dirs.make()
		const first = await runAgainst(join(root, "a"), ["FILTER_IGNORED"])
		expect(first.code).toBe(EXIT.defects)
		expect(first.text).toContain("result: defects — 1 root-cause finding")

		const baseline = join(root, "oat.baseline.json")
		expect((await oat(["baseline", "--from", first.run, "--out", baseline])).code).toBe(0)

		/* The backend regressed: the known defect is still there, and a new one joined it. */
		const second = await runAgainst(join(root, "b"), ["FILTER_IGNORED", "LIMIT_IGNORED"], { baseline })
		expect(second.code).toBe(EXIT.defects)
		expect(second.text).toContain("result: defects — 1 root-cause finding")
		const report = await latestReport(second.out)
		expect(report.outcome).toMatchObject({ exitCode: EXIT.defects, result: "defects" })
		expect(report.findings.find((finding) => finding.check === FILTER)?.known).toBeDefined()
		expect(report.findings.find((finding) => finding.check === LIMIT)?.known).toBeUndefined()

		const diff = await oat(["diff", first.run, second.run])
		expect(diff.code).toBe(0)
		expect(diff.out).toContain("1 new · 0 fixed · 1 persisting")
		expect(diff.out).toMatch(new RegExp(`NEW\\n\\s+${LIMIT}\\s+table`))
		expect(diff.out).toMatch(new RegExp(`PERSISTING\\n\\s+${FILTER}\\s+table`))

		const json = JSON.parse((await oat(["diff", first.run, second.run, "--json"])).out) as {
			new: Array<{ check: string }>
			fixed: unknown[]
			persisting: Array<{ check: string }>
		}
		expect(json.new.map((finding) => finding.check)).toEqual([LIMIT])
		expect(json.fixed).toEqual([])
		expect(json.persisting.map((finding) => finding.check)).toEqual([FILTER])
	}, 60_000)

	it("passes once the backend is fixed, names the entry nothing matches, and diffs it as fixed", async () => {
		const root = await dirs.make()
		const first = await runAgainst(join(root, "a"), ["FILTER_IGNORED"])
		const baseline = join(root, "oat.baseline.json")
		await oat(["baseline", "--from", first.run, "--out", baseline])

		const fixed = await runAgainst(join(root, "b"), [], { baseline })
		expect(fixed.code).toBe(EXIT.clean)
		expect((await latestReport(fixed.out)).baseline?.fixed.map((entry) => entry.check)).toEqual([FILTER])

		const diff = await oat(["diff", first.run, fixed.run])
		expect(diff.code).toBe(0)
		expect(diff.out).toContain("0 new · 1 fixed · 0 persisting")
		expect(diff.out).toMatch(new RegExp(`FIXED\\n\\s+${FILTER}\\s+table`))
		expect(diff.out).toMatch(/COVERAGE\n\s+table\.list\s+failed → passed/)
	}, 60_000)

	it("refuses a folder that holds no run, exit 2", async () => {
		const root = await dirs.make()
		const { code, out } = await oat(["diff", root, root])
		expect(code).toBe(EXIT.usage)
		expect(out).toContain("cannot read")
	})
})
