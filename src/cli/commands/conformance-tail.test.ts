import { describe, expect, it } from "vitest"
import { NODE_FLOOR } from "../../errors/node-floor.ts"
import { bufferWriter } from "../writer.ts"
import { fakeToolkit } from "../__fixtures__/toolkit.ts"
import { POSTGRES_RANGE } from "../../reference/stores/postgres-driver.ts"
import { judgeSkipped, noteD1, runCombinations } from "./conformance-tail.ts"

describe("judgeSkipped", () => {
	it("fails a missing engine unless it was left out by name, and says nothing when none is missing", () => {
		const writer = bufferWriter()
		expect(judgeSkipped(writer, { "skip-backend": "postgres" }, [{ backend: "sqlite" }, { backend: "postgres" }])).toBe(
			1,
		)
		expect(writer.text()).toContain("✗ sqlite backend unavailable")
		expect(writer.text()).toContain("note: postgres backend skipped as asked")
		const none = bufferWriter()
		expect(judgeSkipped(none, {}, [])).toBe(0)
		expect(none.text()).toBe("")
	})

	it("names the Node floor", () => {
		const writer = bufferWriter()
		judgeSkipped(writer, {}, [{ backend: "sqlite" }])
		expect(writer.text()).toContain(
			`✗ sqlite backend unavailable — node:sqlite unavailable on Node ${process.version}; oat needs ${NODE_FLOOR} or later.`,
		)
	})

	it("fails every missing engine when none was left out", () => {
		const writer = bufferWriter()
		expect(judgeSkipped(writer, {}, [{ backend: "postgres" }])).toBe(1)
		expect(writer.text()).toContain("✗ postgres backend unavailable — no Postgres server reachable")
	})

	it("says the Postgres driver is not installed, not that the server is unreachable", () => {
		const writer = bufferWriter()
		expect(judgeSkipped(writer, {}, [{ backend: "postgres", noDriver: true }])).toBe(1)
		expect(writer.text()).toContain(
			`✗ postgres backend unavailable — driver not installed. Run npm install postgres (${POSTGRES_RANGE}), or pass --skip-backend postgres`,
		)
		const asked = bufferWriter()
		expect(judgeSkipped(asked, { "skip-backend": "postgres" }, [{ backend: "postgres", noDriver: true }])).toBe(0)
		expect(asked.text()).toContain("note: postgres backend skipped as asked — driver not installed")
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
