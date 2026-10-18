import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { main } from "../../src/cli/main.ts"
import { UsageError } from "../../src/errors/usage-error.ts"
import { PRINCIPALS } from "../../src/conformance/suite.ts"
import { createMemoryServer } from "../../src/reference/http.ts"
import { baselineFrom, parseBaseline } from "../../src/runtime/baseline.ts"
import { EXIT, exitCode } from "../../src/runtime/exit.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * A backend with defects nobody will fix this week still needs a gate that fails on the next one.
 * A baseline names the known findings: they are reported as known and leave the exit code alone;
 * anything else still fails; a known entry nothing matches any more is reported as fixed.
 */

const dirs: string[] = []
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })))
})

async function runWith(defects: string[], baseline?: ReturnType<typeof parseBaseline>) {
	const server = await createMemoryServer({ defects })
	try {
		return await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...(baseline === undefined ? {} : { baseline }),
		})
	} finally {
		await server.close()
	}
}

describe("a known-findings baseline", () => {
	it("keeps known findings out of the verdict, fails on a new one, and names fixed entries", async () => {
		const first = await runWith(["FILTER_IGNORED"])
		expect(exitCode(first)).toBe(EXIT.defects)
		const baseline = parseBaseline(
			{
				...baselineFrom(first.findings),
				entries: [
					...baselineFrom(first.findings).entries,
					{ check: "pagination.has-more-is-accurate", reason: "fixed in 1.0.89" },
				],
			},
			"test",
		)

		const again = await runWith(["FILTER_IGNORED"], baseline)
		expect(exitCode(again)).toBe(EXIT.clean)
		expect(again.findings.some((finding) => finding.known !== undefined)).toBe(true)
		expect(again.baseline?.fixed.map((entry) => entry.check)).toEqual(["pagination.has-more-is-accurate"])

		const worse = await runWith(["FILTER_IGNORED", "LIMIT_IGNORED"], baseline)
		expect(exitCode(worse)).toBe(EXIT.defects)
	}, 360_000)

	it("refuses a file it cannot read, naming the problem", () => {
		expect(() => parseBaseline({ entries: [{ check: "x" }], version: 1 }, "oat.baseline.json")).toThrow(UsageError)
		expect(() => parseBaseline({ entries: [{ check: "x" }], version: 1 }, "oat.baseline.json")).toThrow(/reason/)
		expect(() =>
			parseBaseline({ entries: [{ check: "x", reason: "r", severity: 1 }], version: 1 }, "oat.baseline.json"),
		).toThrow(/severity/)
		expect(() => parseBaseline({ entries: [], version: 2 }, "oat.baseline.json")).toThrow(/version/)
	})
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

describe("oat baseline --from", () => {
	it("writes one entry per root-cause finding of a run, and will not overwrite without --force", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-baseline-"))
		dirs.push(dir)
		await writeFile(
			join(dir, "oat-report.json"),
			JSON.stringify({
				findings: [
					{ check: "b.check", entity: "row", operations: ["row.list"], summary: "second", verdict: "BACKEND_BUG" },
					{ check: "a.check", entity: "table", operations: ["table.get"], summary: "first", verdict: "SECURITY" },
					{ check: "a.check", entity: "table", operations: ["table.get"], summary: "first", verdict: "SECURITY" },
					{ check: "gap", entity: "table", summary: "not a defect", verdict: "COVERAGE_GAP" },
				],
			}),
		)
		const out = join(dir, "oat.baseline.json")
		expect((await cli(["baseline", "--from", dir, "--out", out])).code).toBe(0)
		expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
			entries: [
				{ check: "a.check", entity: "table", operationId: "table.get", reason: "first" },
				{ check: "b.check", entity: "row", operationId: "row.list", reason: "second" },
			],
			version: 1,
		})
		expect((await cli(["baseline", "--from", dir, "--out", out])).code).toBe(EXIT.usage)
		expect((await cli(["baseline", "--from", dir, "--out", out, "--force"])).code).toBe(0)
	})
})

describe("a config that names a baseline", () => {
	it("stops with a usage error, before anything is sent, when the file cannot be read", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-baseline-config-"))
		dirs.push(dir)
		await writeFile(join(dir, "known.json"), JSON.stringify({ entries: [{ check: "x" }], version: 1 }))
		const config = join(dir, "oat.config.json")
		await writeFile(
			config,
			JSON.stringify({
				baseUrl: "http://127.0.0.1:1",
				baseline: "known.json",
				principals: PRINCIPALS,
				spec: "http://127.0.0.1:1/openapi.json",
			}),
		)
		const result = await cli(["run", "--config", config, "--out", dir, "--quiet"])
		expect(result.code).toBe(EXIT.usage)
		expect(result.out).toContain("reason")
	})
})

describe("oat doctor with a baseline", () => {
	it("warns when the baseline the config names is missing", async () => {
		const server = await createMemoryServer({})
		const dir = await mkdtemp(join(tmpdir(), "oat-baseline-doctor-"))
		dirs.push(dir)
		try {
			const config = join(dir, "oat.config.json")
			await writeFile(config, JSON.stringify({ baseline: "missing.json", spec: `${server.url}/v1/openapi/spec` }))
			const result = await cli(["doctor", "--config", config])
			expect(result.out).toContain("baseline")
			expect(result.out).toContain("missing.json")
		} finally {
			await server.close()
		}
	})
})
