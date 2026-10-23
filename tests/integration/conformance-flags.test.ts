import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeToolkit } from "../../src/cli/__fixtures__/toolkit.ts"
import { loadToolkit, type Toolkit } from "../../src/cli/commands/conformance-toolkit.ts"
import { main } from "../../src/cli/main.ts"
import { bufferWriter } from "../../src/cli/writer.ts"
import type { FuzzCase } from "../../src/conformance/fuzz.ts"
import { postgresStatus, sqliteAvailable } from "../../src/conformance/matrix/engines.ts"

/*
 * `oat conformance` flags, each through the CLI on the smallest leg that shows it: `--parser` runs
 * the document and suite checks without the defect matrix; `--fuzz-seed` is the seed the combination
 * pass prints and replays; `--skip-backend` turns an engine that is not there into a note.
 */

afterEach(() => {
	vi.unstubAllEnvs()
})

async function conformance(argv: string[], toolkit?: Toolkit): Promise<{ code: number; text: string }> {
	const writer = bufferWriter()
	const code = await main(
		["conformance", ...argv],
		toolkit === undefined ? { writer } : { toolkit: async () => toolkit, writer },
	)
	return { code, text: writer.text() }
}

/*
 * The real self-test with its combination pass cut to `cases`: the pass is fixed at 40 combinations,
 * minutes of runs, and the seed decides each one the same way at any length. What each drew is kept.
 */
async function shortCombinations(cases: number, drawn: string[][]): Promise<Toolkit> {
	const real = await loadToolkit()
	const runFuzz: Toolkit["fuzz"]["runFuzz"] = (options = {}) =>
		real.fuzz.runFuzz({ ...options, cases, onCase: (result: FuzzCase) => drawn.push(result.injected) })
	return { ...real, fuzz: { ...real.fuzz, runFuzz } }
}

/* The combination pass as printed: its seed line through its verdict line. */
function combinations(text: string): string {
	const from = text.indexOf("  fuzz seed ")
	const to = text.indexOf("combinations diagnosed correctly", from)
	return text.slice(from, text.indexOf("\n", to))
}

/* A local port nothing listens on: Postgres there is unreachable at once, not after a timeout. */
async function closedPort(): Promise<number> {
	const server = createServer()
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	await new Promise<void>((resolve) => server.close(() => resolve()))
	return port
}

describe("oat conformance --parser", () => {
	it("runs the document and suite checks alone, with no defect matrix", async () => {
		const { code, text } = await conformance(["--parser"])
		expect(code).toBe(0)
		expect(text).toMatch(/ {2}✓ recursive-refs {2,}\d+ ops/)
		expect(text).toMatch(/ {2}(\d+)\/\1 hostile specs handled/)
		expect(text).not.toContain("✗")
		expect(text).not.toContain("injected defects detected")
		expect(text).not.toContain("combination fuzzing")
	}, 90_000)
})

describe("oat conformance --fuzz-seed", () => {
	it("prints the seed it was given, and the same seed replays the same combinations", async () => {
		const drawn: string[][][] = [[], [], []]
		const first = await conformance(
			["--legs", "fuzz", "--fuzz-seed", "7"],
			await shortCombinations(2, drawn[0] as string[][]),
		)
		const again = await conformance(
			["--legs", "fuzz", "--fuzz-seed", "7"],
			await shortCombinations(2, drawn[1] as string[][]),
		)
		const other = await conformance(
			["--legs", "fuzz", "--fuzz-seed", "8"],
			await shortCombinations(2, drawn[2] as string[][]),
		)
		expect([first.code, again.code, other.code]).toEqual([0, 0, 0])
		expect(first.text).toContain("  fuzz seed 7 — replay with --fuzz 40 --max-defects 6 --seed 7\n")
		expect(other.text).toContain("  fuzz seed 8 — replay with --fuzz 40 --max-defects 6 --seed 8\n")
		expect(combinations(first.text)).toContain("2/2 combinations diagnosed correctly")
		expect(combinations(again.text)).toBe(combinations(first.text))
		expect(drawn[0]).toHaveLength(2)
		expect(drawn[1]).toEqual(drawn[0])
		expect(drawn[2]).not.toEqual(drawn[0])
	}, 110_000)
})

/*
 * Only a full run judges a missing engine, and a full run is the whole self-test: its legs are the
 * stand-ins, while whether SQLite and Postgres answer is asked of the real engines.
 */
async function fullRun(argv: string[]): Promise<{ code: number; text: string }> {
	const { toolkit } = fakeToolkit()
	return conformance(argv, { ...toolkit, suite: { ...toolkit.suite, postgresStatus, sqliteAvailable } })
}

describe("oat conformance --skip-backend", () => {
	it("fails a full run whose Postgres is unreachable, unless that backend is skipped by name", async () => {
		vi.stubEnv("PGHOST", "127.0.0.1")
		vi.stubEnv("PGPORT", String(await closedPort()))
		const missing = await fullRun([])
		expect(missing.code).toBe(1)
		expect(missing.text).toContain(
			"  ✗ postgres backend unavailable — no Postgres server reachable on the default connection. Start it, or pass --skip-backend postgres\n",
		)
		const skipped = await fullRun(["--skip-backend", "postgres"])
		expect(skipped.code).toBe(0)
		expect(skipped.text).toContain(
			"  note: postgres backend skipped as asked — no Postgres server reachable on the default connection\n",
		)
		expect(skipped.text).not.toContain("backend unavailable")
	}, 30_000)
})
