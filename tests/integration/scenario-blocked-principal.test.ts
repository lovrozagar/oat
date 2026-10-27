import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { PRINCIPALS } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { EXIT } from "../../src/runtime/exit.ts"
import { latestReport, oat, referenceConfig, tempDirs } from "../support/cli-run.ts"

/*
 * A scenario that names a configured principal whose sign-in was refused cannot run: it is
 * BLOCKED by that principal, its operations stay ungraded, and the run still ends with a report.
 */

const dirs = tempDirs("oat-scenario-blocked-")
afterAll(dirs.removeAll)

describe("a scenario as a principal BLOCKED at sign-in", () => {
	it("is reported BLOCKED by that principal, and the run reaches its report", async () => {
		const dir = await dirs.make()
		const server = await createMemoryServer({ defects: [] })
		try {
			const config = await referenceConfig(dir, server.url, {
				principals: { ...PRINCIPALS, beta: { ...PRINCIPALS["beta"], key: "key_refused" } },
				scenarios: [{ covers: ["table.get"], id: "peer", principal: "beta", steps: [{ operationId: "table.get" }] }],
			})
			const runs = join(dir, "runs")
			const { code, out } = await oat(["run", "--config", config, "--out", runs, "--ops", "table.get", "--quiet"])
			/* BLOCKED is no defect, as for a principal the matrix could not sign in: alpha still grades table.get. */
			expect(code).toBe(EXIT.clean)
			expect(out).toMatch(/BLOCKED \(2\)/)
			const report = await latestReport(runs)
			expect(report.findings.filter((finding) => finding.check === "scenario.peer")).toEqual([
				expect.objectContaining({ entity: "peer", verdict: "BLOCKED" }),
			])
		} finally {
			await server.close()
		}
	}, 60_000)
})
