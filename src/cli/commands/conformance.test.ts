import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { fakeToolkit, type ToolkitOptions } from "../__fixtures__/toolkit.ts"
import { commandConformance } from "./conformance.ts"

/*
 * The self-test's front: selectors checked before anything runs, the suites, then the parser-only,
 * precision or fuzz pass, or the full matrix with the engines that were missing, the combination
 * pass and the D1 note.
 */

async function conformance(flags: Record<string, string | true>, options: ToolkitOptions = {}) {
	const { toolkit, log } = fakeToolkit(options)
	const writer = bufferWriter()
	const code = await commandConformance(writer, flags, async () => toolkit)
	return { code, log, text: writer.text() }
}

describe("commandConformance refusals", () => {
	it("refuses a selector it does not know before running anything", async () => {
		const refusals: Array<[Record<string, string | true>, string]> = [
			[{ backend: "nope" }, 'oat: unknown --backend "nope" — expected memory, sqlite, postgres, d1\n'],
			[{ dialect: "nope" }, 'oat: unknown --dialect "nope" — expected classic, postgrest\n'],
			[{ only: true }, "oat: --only needs a comma-separated list of defect names\n"],
			[{ only: "," }, "oat: --only needs a comma-separated list of defect names\n"],
			[{ only: "A,Z,Y" }, "oat: --only names no defect: Z, Y\n"],
		]
		for (const [flags, said] of refusals) {
			const { code, log, text } = await conformance(flags)
			expect([code, text, log]).toEqual([2, said, []])
		}
	})

	it("loads the real self-test by default", async () => {
		const writer = bufferWriter()
		expect(await commandConformance(writer, { backend: "nope" })).toBe(2)
	})
})

describe("commandConformance passes", () => {
	it("runs the suites alone with --parser, judging the tag unlocks itself", async () => {
		const { code, log } = await conformance({ parser: true }, { cases: [{ label: "p" }] })
		expect(code).toBe(0)
		expect(log).toEqual([
			"parser",
			"example",
			"unlocks own",
			"coverage",
			"tenant",
			"featureGate",
			"rateLimit",
			"unique",
			"seedContract",
			"effects",
			"payloads",
		])
	})

	it("fails when a suite does", async () => {
		expect((await conformance({ parser: true }, { cases: [{ failed: true, label: "p" }] })).code).toBe(1)
	})

	it("varies the data against a correct backend with --precision", async () => {
		const plain = await conformance({ precision: true })
		expect(plain.log).toContain('precision {"backend":"memory","cases":50,"dialect":"postgrest","seed":1}')
		const asked = await conformance({ backend: "sqlite", dialect: "classic", precision: "7", seed: "0" })
		expect(asked.log).toContain('precision {"backend":"sqlite","cases":7,"dialect":"classic","seed":1}')
	})

	it("injects defect combinations instead of the matrix with --fuzz", async () => {
		const plain = await conformance({ fuzz: true })
		expect(plain.log).toContain('fuzz {"backend":"memory","cases":25,"dialect":"postgrest","maxDefects":4,"seed":1}')
		const zero = await conformance({ fuzz: true, seed: "0" })
		expect(zero.log).toContain('fuzz {"backend":"memory","cases":25,"dialect":"postgrest","maxDefects":4,"seed":1}')
		const asked = await conformance({ backend: "postgres", fuzz: "9", "max-defects": "2", seed: "5" })
		expect(asked.log).toContain('fuzz {"backend":"postgres","cases":9,"dialect":"postgrest","maxDefects":2,"seed":5}')
		expect(asked.log.some((entry) => entry.startsWith("pool"))).toBe(false)
	})
})

describe("commandConformance full runs", () => {
	it("fails an engine that is missing unless it is left out by name, then combines and notes D1", async () => {
		const missing = await conformance({})
		expect(missing.code).toBe(1)
		expect(missing.text).toContain("  ✗ sqlite backend unavailable — node:sqlite unavailable")
		expect(missing.text).toContain("  ✗ postgres backend unavailable — no Postgres server reachable")
		expect(missing.log).toContain('fuzz {"backend":"memory","cases":40,"maxDefects":6,"seed":1}')
		expect(missing.text).toContain("note: d1 backend needs CLOUDFLARE_ACCOUNT_ID")
		const allowed = await conformance({ "fuzz-seed": "8", "skip-backend": "sqlite,postgres" }, { d1: true })
		expect(allowed.code).toBe(0)
		expect(allowed.text).toContain("  note: sqlite backend skipped as asked")
		expect(allowed.text).toContain("fuzz seed 8 — replay with --fuzz 40 --max-defects 6 --seed 8")
		expect(allowed.text).toContain("note: d1 backend available")
	})

	it("runs every local engine that answers, with no combination pass for a filtered run", async () => {
		const all = await conformance({ only: "A" }, { postgres: true, sqlite: true })
		expect(all.code).toBe(0)
		expect(all.log.filter((entry) => entry.startsWith("task baselines"))).toEqual([
			"task baselines memory/postgrest",
			"task baselines sqlite/postgrest",
			"task baselines postgres/postgrest",
			"task baselines memory/classic",
			"task baselines memory/linked",
			"task baselines memory/jsonapi",
			"task baselines memory/plain",
			"task baselines memory/template",
		])
		expect(all.log.some((entry) => entry.startsWith("fuzz"))).toBe(false)
	})

	it("runs only the engine asked for, with nothing after its matrix", async () => {
		const asked = await conformance({ backend: "sqlite", jobs: "2" })
		expect(asked.log).toContain("pool 2")
		expect(asked.text).not.toContain("note:")
		expect(asked.log.some((entry) => entry.startsWith("fuzz"))).toBe(false)
	})
})
