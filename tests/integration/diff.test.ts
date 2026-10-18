import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { main } from "../../src/cli/main.ts"
import { parseArgs } from "../../src/cli/flags.ts"
import { diffReports } from "../../src/report/diff.ts"

/*
 * Two runs of the same backend, compared: which defects are new, which are gone, which persist —
 * recognised by a key that survives run-specific ids and ports — and which operations changed
 * status. A report, not a gate: it exits 0 unless it cannot read its inputs.
 */

const finding = (check: string, detail: string, operations = ["table.list"]) => ({
	check,
	detail,
	entity: "table",
	evidence: [],
	operations,
	summary: `${check} broke`,
	verdict: "BACKEND_BUG",
})

const A = {
	findings: [
		finding("list.read-after-write", "created tbl_a1b2c (port http://127.0.0.1:4000) is missing"),
		finding("pagination.limit-bounds-page-size", "limit=2 returned 5"),
		{ ...finding("gap", "not graded"), verdict: "COVERAGE_GAP" },
	],
	scope: {
		operations: [
			{ operationId: "table.list", status: "failed" },
			{ operationId: "table.get", status: "passed" },
		],
	},
	targetVersion: { value: "1.0.88" },
}

const B = {
	findings: [
		finding("list.read-after-write", "created tbl_z9y8x (port http://127.0.0.1:5123) is missing"),
		finding("filter.unknown-field-rejected", "unknown field ignored"),
	],
	scope: {
		operations: [
			{ operationId: "table.list", status: "failed" },
			{ operationId: "table.get", status: "failed" },
		],
	},
	targetVersion: { value: "1.0.89" },
}

describe("diffReports", () => {
	it("splits root causes into new, fixed and persisting, by a key that survives run-specific values", () => {
		const diff = diffReports(A, B)
		expect(diff.new.map((f) => f.check)).toEqual(["filter.unknown-field-rejected"])
		expect(diff.fixed.map((f) => f.check)).toEqual(["pagination.limit-bounds-page-size"])
		expect(diff.persisting.map((f) => f.check)).toEqual(["list.read-after-write"])
	})

	it("lists operations whose status changed, and both target versions", () => {
		const diff = diffReports(A, B)
		expect(diff.coverage).toEqual([{ from: "passed", operationId: "table.get", to: "failed" }])
		expect(diff.versions).toEqual({ a: "1.0.88", b: "1.0.89" })
	})

	it("says coverage cannot be compared when a report has no scope", () => {
		expect(diffReports({ findings: [] }, B).coverage).toBeNull()
	})
})

const dirs: string[] = []
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })))
})

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
	const saved = process.argv
	const chunks: string[] = []
	const capture = (chunk: string | Uint8Array): boolean => {
		chunks.push(String(chunk))
		return true
	}
	const write = vi.spyOn(process.stdout, "write").mockImplementation(capture)
	const err = vi.spyOn(process.stderr, "write").mockImplementation(capture)
	process.argv = ["node", "oat", ...argv]
	try {
		return { code: await main(), out: chunks.join("") }
	} finally {
		process.argv = saved
		write.mockRestore()
		err.mockRestore()
	}
}

describe("oat diff", () => {
	it("takes two run folders as positionals", () => {
		expect(parseArgs(["diff", "a", "b", "--json"]).positionals).toEqual(["a", "b"])
		expect(parseArgs(["run", "--config", "x.json"]).positionals).toBeUndefined()
	})

	it("prints the comparison, as text or JSON, and exits 0", async () => {
		const root = await mkdtemp(join(tmpdir(), "oat-diff-"))
		dirs.push(root)
		for (const [name, report] of [
			["a", A],
			["b", B],
		] as const) {
			await mkdir(join(root, name))
			await writeFile(join(root, name, "oat-report.json"), JSON.stringify(report))
		}
		const text = await cli(["diff", join(root, "a"), join(root, "b")])
		expect(text.code).toBe(0)
		expect(text.out).toContain("1 new")
		expect(text.out).toContain("filter.unknown-field-rejected")
		expect(text.out).toContain("1.0.88 → 1.0.89")
		const json = await cli(["diff", join(root, "a"), join(root, "b"), "--json"])
		expect(JSON.parse(json.out).new).toHaveLength(1)
	})

	it("exits 2 when it cannot read a run", async () => {
		expect((await cli(["diff", "/nowhere/a", "/nowhere/b"])).code).toBe(2)
		expect((await cli(["diff", "/nowhere/a"])).code).toBe(2)
	})
})
