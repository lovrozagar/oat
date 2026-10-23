import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Flags } from "../flags.ts"
import { bufferWriter } from "../writer.ts"
import { folder } from "../__fixtures__/files.ts"
import { fakeToolkit, type ToolkitOptions } from "../__fixtures__/toolkit.ts"
import { commandConformance } from "./conformance.ts"

/*
 * The self-test's front: selectors checked before anything runs; then the legs — everything on a
 * full run, the suites and passes for a selected backend, dialect or defect, exactly the `--legs`
 * asked for — or the precision or fuzz question in place of the matrix.
 */

async function conformance(flags: Flags, options: ToolkitOptions = {}) {
	const { toolkit, log } = fakeToolkit(options)
	const writer = bufferWriter()
	const code = await commandConformance(writer, flags, async () => toolkit)
	return { code, log, text: writer.text() }
}

const SUITES = [
	"parser",
	"example",
	"coverage",
	"tenant",
	"featureGate",
	"rateLimit",
	"unique",
	"seedContract",
	"effects",
	"payloads",
]

describe("commandConformance refusals", () => {
	it("refuses a selector it does not know before running anything", async () => {
		const refusals: Array<[Flags, string]> = [
			[{ backend: "nope" }, 'oat: unknown --backend "nope" — expected memory, sqlite, postgres, d1\n'],
			[{ dialect: "nope" }, 'oat: unknown --dialect "nope" — expected classic, postgrest\n'],
			[{ legs: "," }, "oat: --legs needs a comma-separated list of suites, passes, shapes, recall, scope, fuzz\n"],
			[
				{ legs: "passes,tea" },
				"oat: --legs names no leg: tea — expected suites, passes, shapes, recall, scope, fuzz\n",
			],
			[{ only: "," }, "oat: --only needs a comma-separated list of defect names\n"],
			[{ only: "A,Z,Y" }, "oat: --only names no defect: Z, Y\n"],
			[{ shapes: "prefix,nope" }, "oat: --shapes names no shape: nope\n"],
			[{ backend: "d1", fuzz: true }, "oat: --fuzz runs on a local engine — expected memory, sqlite, postgres\n"],
			[
				{ backend: "d1", precision: "5" },
				"oat: --precision runs on a local engine — expected memory, sqlite, postgres\n",
			],
		]
		for (const [flags, said] of refusals) {
			const { code, log, text } = await conformance(flags, { shapes: [{ label: "shape:prefix", problems: [] }] })
			expect([code, text, log]).toEqual([2, said, []])
		}
	})

	it("loads the real self-test by default", async () => {
		expect(await commandConformance(bufferWriter(), { backend: "nope" })).toBe(2)
	})
})

describe("commandConformance legs", () => {
	it("runs every leg on a full run, failing an engine that is missing unless it is left out by name", async () => {
		const missing = await conformance({}, { shapes: [{ label: "shape:prefix", problems: [] }] })
		expect(missing.code).toBe(1)
		expect(missing.log.slice(0, 10)).toEqual(SUITES)
		expect(missing.log).toContain("task shape-reference")
		expect(missing.log.some((entry) => entry.startsWith("task recall"))).toBe(true)
		expect(missing.log.some((entry) => entry.startsWith("task scope"))).toBe(true)
		expect(missing.log).toContain('fuzz {"backend":"memory","cases":40,"maxDefects":6,"seed":1}')
		expect(missing.text).toContain("  ✗ sqlite backend unavailable")
		expect(missing.text).toContain("unproven ")
		expect(missing.text).toContain("note: d1 backend needs")
		const allowed = await conformance({ "skip-backend": "sqlite,postgres" }, { d1: true, postgres: false })
		expect(allowed.code).toBe(0)
		expect(allowed.text).toContain("note: d1 backend available")
	})

	it("runs the suites and the passes alone for a selected engine or dialect", async () => {
		const sqlite = await conformance({ backend: "sqlite", jobs: "2" })
		expect(sqlite.log).toContain("pool 2")
		expect(sqlite.log.filter((entry) => entry.startsWith("task baselines"))).toEqual([
			"task baselines sqlite/postgrest",
		])
		expect(sqlite.log.some((entry) => /^task (shape|recall|scope)/.test(entry) || entry.startsWith("fuzz"))).toBe(false)
		expect(sqlite.text).not.toContain("note:")
		const classic = await conformance({ backend: "memory", dialect: "classic" })
		expect(classic.log).toContain("unlocks own")
		expect(classic.log.some((entry) => entry.startsWith("task shape"))).toBe(false)
		const local = await conformance({ only: "A" }, { postgres: true, sqlite: true })
		expect(local.log.filter((entry) => entry.startsWith("task baselines"))).toHaveLength(8)
	})

	it("runs exactly the legs asked for, scope bringing the default pass it judges from", async () => {
		const scope = await conformance({ legs: "scope" })
		expect(scope.log.slice(0, 1)).toEqual(["pool 3"])
		expect(scope.log.filter((entry) => entry.startsWith("task baselines"))).toEqual(["task baselines memory/postgrest"])
		const fuzzOnly = await conformance({ "fuzz-seed": "8", legs: "fuzz" })
		expect(fuzzOnly.log).toEqual(['fuzz {"backend":"memory","cases":40,"maxDefects":6,"seed":8}'])
		const suites = await conformance({ parser: true }, { cases: [{ failed: true, label: "p" }] })
		expect([suites.code, suites.log]).toEqual([1, [...SUITES.slice(0, 2), "unlocks own", ...SUITES.slice(2)]])
	})

	it("writes what a leg proved where --proven-out says", async () => {
		const out = join(folder(), "legs", "memory.json")
		await conformance({ backend: "memory", legs: "passes", "proven-out": out }, { proven: ["check.a"] })
		expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ legs: ["passes"], proven: ["check.a"] })
	})

	it("judges a sharded run's proven files with --aggregate", async () => {
		const dir = folder()
		await conformance({ legs: "passes", "proven-out": join(dir, "a.json") }, { proven: ["check.a"] })
		const judged = await conformance({ aggregate: dir }, { unproven: ["check.a", "check.z"] })
		expect(judged.code).toBe(1)
		expect(judged.log).toEqual([])
		expect(judged.text).toContain("1 leg file(s) · 1 check(s) proven")
	})
})

describe("commandConformance questions", () => {
	it("varies the data against a correct backend with --precision", async () => {
		const plain = await conformance({ precision: true })
		expect(plain.log).toContain('precision {"backend":"memory","cases":50,"dialect":"postgrest","seed":1}')
		const asked = await conformance({ backend: "sqlite", dialect: "classic", precision: "7", seed: "0" })
		expect(asked.log).toContain('precision {"backend":"sqlite","cases":7,"dialect":"classic","seed":1}')
	})

	it("injects defect combinations instead of the matrix with --fuzz", async () => {
		const plain = await conformance({ fuzz: true, seed: "0" })
		expect(plain.log).toContain('fuzz {"backend":"memory","cases":25,"dialect":"postgrest","maxDefects":4,"seed":1}')
		const asked = await conformance({ backend: "postgres", fuzz: "9", "max-defects": "2", seed: "5" })
		expect(asked.log).toContain('fuzz {"backend":"postgres","cases":9,"dialect":"postgrest","maxDefects":2,"seed":5}')
		expect(asked.log.some((entry) => entry.startsWith("pool"))).toBe(false)
		const unseeded = await conformance({ fuzz: "3" })
		expect(unseeded.log).toContain('fuzz {"backend":"memory","cases":3,"dialect":"postgrest","maxDefects":4,"seed":1}')
	})
})

describe("commandConformance without the Postgres driver", () => {
	it("tells a missing Postgres driver apart: skipped as asked on a full run, a usage error when asked for", async () => {
		const full = await conformance({ "skip-backend": "sqlite,postgres" }, { postgres: "no-driver" })
		expect(full.code).toBe(0)
		expect(full.text).toContain("note: postgres backend skipped as asked — driver not installed")
		const asked = await conformance({ backend: "postgres" }, { postgres: "no-driver" })
		expect(asked.code).toBe(2)
		expect(asked.text).toContain("oat: --backend postgres needs the postgres package (^3.4): npm install postgres\n")
		expect(asked.log.some((entry) => entry.startsWith("task"))).toBe(false)
	})
})
