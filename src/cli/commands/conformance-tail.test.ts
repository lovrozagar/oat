import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { fakeToolkit } from "../__fixtures__/toolkit.ts"
import { judgeSkipped, noteD1, runCombinations } from "./conformance-tail.ts"

describe("judgeSkipped", () => {
	it("fails a missing engine unless it was left out by name, and says nothing when none is missing", () => {
		const writer = bufferWriter()
		expect(judgeSkipped(writer, { "skip-backend": "postgres" }, ["sqlite", "postgres"])).toBe(1)
		expect(writer.text()).toContain("✗ sqlite backend unavailable")
		expect(writer.text()).toContain("note: postgres backend skipped as asked")
		const none = bufferWriter()
		expect(judgeSkipped(none, {}, [])).toBe(0)
		expect(none.text()).toBe("")
	})

	it("fails every missing engine when none was left out", () => {
		const writer = bufferWriter()
		expect(judgeSkipped(writer, {}, ["postgres"])).toBe(1)
		expect(writer.text()).toContain("✗ postgres backend unavailable")
	})
})

describe("runCombinations", () => {
	it("runs 40 combinations on the given seed, printing how to replay them", async () => {
		const { toolkit, log } = fakeToolkit({ cases: [{ failed: true, label: "combo" }] })
		const writer = bufferWriter()
		expect(await runCombinations(writer, { "fuzz-seed": "12" }, toolkit)).toBe(1)
		expect(log).toEqual(['fuzz {"backend":"memory","cases":40,"maxDefects":6,"seed":12}'])
		expect(writer.text()).toContain("fuzz seed 12 — replay with --fuzz 40 --max-defects 6 --seed 12")
		expect(writer.text()).toMatch(/\n {2}requests: 7\n {2}requests by source:\n {4}check a: 4\n {4}seed: 3\n$/)
	})

	it("runs on seed 1 when none is given", async () => {
		const { toolkit, log } = fakeToolkit()
		expect(await runCombinations(bufferWriter(), {}, toolkit)).toBe(0)
		expect(log).toEqual(['fuzz {"backend":"memory","cases":40,"maxDefects":6,"seed":1}'])
	})
})

describe("noteD1", () => {
	it("says how to reach D1, or what it needs", () => {
		const ready = bufferWriter()
		noteD1(ready, fakeToolkit({ d1: true }).toolkit)
		expect(ready.text()).toContain("d1 backend available")
		const missing = bufferWriter()
		noteD1(missing, fakeToolkit().toolkit)
		expect(missing.text()).toContain("needs CLOUDFLARE_ACCOUNT_ID")
	})
})
