import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { EXIT } from "../../src/runtime/exit.ts"
import { latestJournal, latestReport, oat, referenceConfig, tempDirs } from "../support/cli-run.ts"

/*
 * A second host with a document of its own, run by the same principals as the primary. Its
 * operations are named `<origin>:<operationId>`, its findings carry the origin into every report,
 * and a diff of two runs tells a defect on the origin from the same defect on the primary.
 */

const dirs = tempDirs("oat-origins-")
afterAll(dirs.removeAll)

const FILTER = "filter.unknown-field-rejected"

/* Each defect list is one reference: the primary's, then the `cdn` origin's. */
interface Hosts {
	primary: string[]
	cdn: string[]
}

/*
 * `oat run --ops <ops>` against two references, `cdn` an origin of the first. The origin signs no
 * one in: the primary's jwt is sent there, and its apiKey scheme, minted on the primary only, is
 * dropped from its document.
 */
async function runBoth(dir: string, hosts: Hosts, ops: string) {
	const primary = await createMemoryServer({ defects: hosts.primary })
	const cdn = await createMemoryServer({ defects: hosts.cdn })
	try {
		const origin = {
			baseUrl: cdn.url,
			id: "cdn",
			overlay: { securitySchemes: { apiKey: null } },
			security: { jwt: "jwt" },
			spec: `${cdn.url}/v1/openapi/spec`,
		}
		const config = await referenceConfig(dir, primary.url, { origins: [origin] })
		const runs = join(dir, "runs")
		const { code, out } = await oat(["run", "--config", config, "--out", runs, "--ops", ops, "--quiet"])
		return { cdnUrl: cdn.url, code, run: join(runs, "latest"), runs, text: out }
	} finally {
		await Promise.all([primary.close(), cdn.close()])
	}
}

describe("a run over a primary and a secondary origin", () => {
	it("grades the origin's operations as its own and stamps its findings with it", async () => {
		const { code, runs, text } = await runBoth(
			await dirs.make(),
			{ cdn: ["FILTER_IGNORED"], primary: [] },
			"table.list,cdn:table.list",
		)
		expect(code).toBe(EXIT.defects)
		expect(text).toMatch(/✓ table\.list\s+passed/)
		expect(text).toMatch(/✗ cdn:table\.list\s+failed .*filter\.unknown-field-rejected/)
		expect(text).toMatch(/cdn\/table\s+unknown filter field is silently ignored/)
		const report = await latestReport(runs)
		const rows = report.scope.operations.map((op) => [op.origin ?? "", op.operationId, op.status])
		expect(rows).toEqual(
			expect.arrayContaining([
				["", "table.list", "passed"],
				["cdn", "table.list", "failed"],
			]),
		)
		expect(report.findings.filter((finding) => finding.verdict === "BACKEND_BUG")).toEqual([
			expect.objectContaining({ check: FILTER, entity: "table", origin: "cdn" }),
		])
	}, 60_000)

	it("does not run an origin no target names", async () => {
		const { cdnUrl, code, runs } = await runBoth(
			await dirs.make(),
			{ cdn: ["FILTER_IGNORED"], primary: [] },
			"table.get",
		)
		expect(code).toBe(EXIT.clean)
		expect((await latestReport(runs)).scope.originsSkipped).toEqual(["cdn"])
		expect((await latestJournal(runs)).some((line) => line.url.startsWith(cdnUrl))).toBe(false)
	}, 60_000)
})

describe("oat diff over runs on two origins", () => {
	it("reads a defect that moved from the primary to the origin as one fixed and one new", async () => {
		const root = await dirs.make()
		const ops = "table.list,cdn:table.list"
		const before = await runBoth(join(root, "a"), { cdn: [], primary: ["FILTER_IGNORED"] }, ops)
		const after = await runBoth(join(root, "b"), { cdn: ["FILTER_IGNORED"], primary: [] }, ops)
		expect([before.code, after.code]).toEqual([EXIT.defects, EXIT.defects])
		const diff = await oat(["diff", before.run, after.run])
		expect(diff.code).toBe(0)
		expect(diff.out).toContain("1 new · 1 fixed · 0 persisting")
	}, 60_000)
})
