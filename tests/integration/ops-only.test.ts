import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { EXIT } from "../../src/runtime/exit.ts"
import { latestReport, oat, referenceConfig, tempDirs } from "../support/cli-run.ts"

/*
 * `--ops` grades the operations it names; `--only` grades every operation the entities it names
 * own; together they are a union. Everything else is support: called to reach or observe a target,
 * never graded, so a defect only support shows does not fail the run. `--ops` alone is covered in
 * cli-flags.test.ts; this file is the two together, and `--only`, against a defective backend.
 */

const dirs = tempDirs("oat-ops-only-")
afterAll(dirs.removeAll)

/* Seen on table.list and row.list, never on table.get. */
const DEFECT = "FILTER_IGNORED"

/* `oat run <flags>` against a reference with the defect; `runs` is its --out. */
async function runScoped(flags: string[]) {
	const server = await createMemoryServer({ defects: [DEFECT] })
	try {
		const dir = await dirs.make()
		const config = await referenceConfig(dir, server.url)
		const runs = join(dir, "runs")
		const { code, out } = await oat(["run", "--config", config, "--out", runs, "--quiet", ...flags])
		return { code, runs, text: out }
	} finally {
		await server.close()
	}
}

describe("--only", () => {
	it("grades every operation the entity owns, and fails on the defect one of them shows", async () => {
		const { code, runs, text } = await runScoped(["--only", "table"])
		expect(code).toBe(EXIT.defects)
		expect(text).toContain("scope: targeted · 8 operations (--only table)")
		expect(text).toMatch(/✗ table\.list\s+failed .*filter\.unknown-field-rejected/)
		const report = await latestReport(runs)
		expect(report.scope.mode).toBe("targeted")
		const graded = report.scope.operations.map((op) => op.operationId)
		expect(graded).toEqual(expect.arrayContaining(["table.create", "table.get", "table.list", "table.update"]))
		expect(graded.some((id) => id.startsWith("row."))).toBe(false)
	}, 60_000)

	it("refuses, exit 2, an entity the document lacks, naming the nearest", async () => {
		const { code, text } = await runScoped(["--only", "tabel"])
		expect(code).toBe(EXIT.usage)
		expect(text).toContain('--only "tabel" names no entity. Did you mean: table?')
	})
})

describe("--ops", () => {
	it("passes when the defect shows only on support it called", async () => {
		const { code, runs, text } = await runScoped(["--ops", "table.get"])
		expect(code).toBe(EXIT.clean)
		expect(text).toMatch(/✓ table\.get\s+passed/)
		const report = await latestReport(runs)
		expect(report.scope.operations.map((op) => op.operationId)).toEqual(["table.get"])
		expect(report.findings.filter((finding) => finding.verdict === "BACKEND_BUG")).toEqual([])
	}, 60_000)
})

describe("--ops with --only", () => {
	it("grades the union, and fails on the defect the entity's list shows", async () => {
		const { code, runs, text } = await runScoped(["--ops", "table.get", "--only", "row"])
		expect(code).toBe(EXIT.defects)
		expect(text).toContain("(--ops table.get --only row)")
		const graded = (await latestReport(runs)).scope.operations.map((op) => op.operationId)
		expect(graded.sort()).toEqual(["row.create", "row.delete", "row.get", "row.list", "row.update", "table.get"])
		expect(text).toMatch(/✗ row\.list\s+failed/)
		expect(text).toMatch(/✓ table\.get\s+passed/)
	}, 60_000)
})
