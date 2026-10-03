import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer, type ReferenceServer } from "../src/reference/http.ts"
import { buildMatrixGraphFromReport } from "../src/report/matrix.ts"
import { coverageByCheck, renderConsole, renderJson, renderMarkdown, type ReportInput } from "../src/report/render.ts"
import type { ProgressSnapshot } from "../src/runtime/progress.ts"
import { run } from "../src/runtime/run.ts"

let server: ReferenceServer
beforeAll(async () => {
	server = await createMemoryServer({ defects: ["PATCH_REPLACES"] })
})
afterAll(async () => {
	await server.close()
})

async function report(ops?: string[]): Promise<{ input: ReportInput; progress: ProgressSnapshot[] }> {
	const progress: ProgressSnapshot[] = []
	const result = await run({
		baseUrl: server.url,
		onProgress: (snap) => progress.push(snap),
		principals: PRINCIPALS,
		seed: 42,
		spec: `${server.url}/v1/openapi/spec`,
		...(ops === undefined ? {} : { ops }),
	})
	return {
		input: {
			baseUrl: server.url,
			checksOutOfScope: result.checksOutOfScope,
			checksRun: result.checksRun,
			checksSkipped: result.checksSkipped,
			checksSuppressed: result.checksSuppressed,
			client: result.client,
			durationMs: 1,
			entitiesTested: result.entitiesTested,
			findings: result.findings,
			inconclusive: result.inconclusive,
			model: result.model,
			profile: result.profile,
			profileExclusions: result.profileExclusions,
			scope: result.scope,
			startedAt: new Date(0),
		},
		progress,
	}
}

describe("scope in reports", () => {
	it("a targeted run says so everywhere, per operation", async () => {
		const { input, progress } = await report(["table.get", "table.update"])

		const md = renderMarkdown(input)
		expect(md).toContain("- **Scope**: targeted — 2 operations (--ops table.get,table.update)")
		expect(md).toContain("## Operations")
		expect(md).toMatch(/\| table\.get \| table \| held \|/)
		expect(md).toMatch(/\| table\.update \| table \| failed \|/)
		expect(md).toContain("## Support operations")
		expect(md).toMatch(/\| table\.create \| \d+ \|/)

		const json = JSON.parse(renderJson(input)) as {
			scope: { mode: string; operations: Array<{ operationId: string; status: string }>; support: unknown[] }
			findings: Array<{ check: string; operations?: string[] }>
		}
		expect(json.scope.mode).toBe("targeted")
		expect(json.scope.operations.map((op) => [op.operationId, op.status])).toEqual([
			["table.get", "held"],
			["table.update", "failed"],
		])
		expect(json.findings.find((f) => f.check === "patch.minimality")?.operations).toEqual(["table.update"])

		const text = renderConsole(input)
		expect(text).toContain("scope: targeted · 2 operations (--ops table.get,table.update)")
		expect(text).toMatch(/✓ table\.get\s+held/)
		expect(text).toMatch(/✗ table\.update\s+failed/)

		expect(progress.some((snap) => snap.phase === "load" && snap.message?.startsWith("scope: targeted"))).toBe(true)
	})

	it("out-of-scope checks are neither run nor skipped in coverage and the matrix", async () => {
		const { input } = await report(["table.get"])
		const ids = new Set(input.checksOutOfScope?.map((item) => item.check))
		expect(ids.has("patch.minimality")).toBe(true)
		const coverage = coverageByCheck(input)
		expect(coverage.partialSkip.some((row) => ids.has(row.check) && row.ran > 0)).toBe(false)
		const graph = buildMatrixGraphFromReport(input)
		const table = graph.entities.find((entity) => entity.name === "table")
		expect(table?.nodes.find((node) => node.id === "patch.minimality")?.status).toBe("out-of-scope")
		expect(table?.nodes.find((node) => node.id === "tenant.item-not-readable-cross-tenant")?.status).toBe("held")
	})

	it("a full run lists every operation with its status", async () => {
		const { input } = await report()
		const md = renderMarkdown(input)
		expect(md).toContain("- **Scope**: full")
		expect(md).toMatch(/\| auth\.token \| — \| untested \|/)
		expect(md).not.toContain("## Support operations")
		expect(renderConsole(input)).toMatch(/scope: full · \d+ of \d+ operations graded/)
	})
})
