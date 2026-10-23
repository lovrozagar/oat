import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { folder, savedRun } from "../__fixtures__/files.ts"
import { commandDiff } from "./diff.ts"

/* Two runs side by side: new, fixed and persisting findings. A report, never a gate. */

const finding = (entity: string) => ({
	check: "c",
	detail: "d",
	entity,
	evidence: [],
	summary: "s",
	verdict: "BACKEND_BUG",
})

describe("commandDiff", () => {
	it("compares two runs, as text or JSON", async () => {
		const dir = folder()
		const before = savedRun(dir, "a", { findings: [finding("note")] })
		const after = savedRun(dir, "b", { findings: [finding("tag")] })
		const text = bufferWriter()
		expect(await commandDiff(text, {}, [before, after])).toBe(0)
		expect(text.text().length).toBeGreaterThan(0)
		const machine = bufferWriter()
		expect(await commandDiff(machine, { json: true }, [before, after])).toBe(0)
		expect(JSON.parse(machine.text())).toBeTypeOf("object")
	})

	it("refuses without two runs, and names a run it cannot read", async () => {
		const dir = folder()
		const ok = savedRun(dir, "ok", { findings: [] })
		const lacking = bufferWriter()
		expect(await commandDiff(lacking, {}, [ok])).toBe(2)
		expect(lacking.text()).toBe("oat: diff needs two run folders: oat diff <runA> <runB>\n")
		const listless = bufferWriter()
		expect(await commandDiff(listless, {}, [ok, savedRun(dir, "bad", { findings: 1 })])).toBe(2)
		expect(listless.text()).toMatch(/bad\/oat-report\.json: it holds no findings list\n$/)
		const missing = bufferWriter()
		expect(await commandDiff(missing, {}, [join(dir, "gone"), ok])).toBe(2)
		expect(missing.text()).toMatch(/^oat: cannot read .*gone\/oat-report\.json: /)
	})

	it("refuses a report from a newer schema, and reads one from 0.24 or schema 1", async () => {
		const dir = folder()
		const old = savedRun(dir, "old", { findings: [] })
		const current = savedRun(dir, "current", { findings: [], schemaVersion: 1 })
		expect(await commandDiff(bufferWriter(), {}, [old, current])).toBe(0)
		const newer = bufferWriter()
		expect(await commandDiff(newer, {}, [current, savedRun(dir, "newer", { findings: [], schemaVersion: 2 })])).toBe(2)
		expect(newer.text()).toBe(
			`oat: ${join(dir, "newer", "oat-report.json")} is report schemaVersion 2; this oat reads 1 — upgrade oat\n`,
		)
	})
})
