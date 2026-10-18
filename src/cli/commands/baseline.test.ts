import { readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { folder, json, savedRun } from "../__fixtures__/files.ts"
import { commandBaseline } from "./baseline.ts"

/* A run's root-cause findings, written as the baseline the next runs measure against. */

const finding = {
	check: "list.read-after-write",
	detail: "d",
	entity: "note",
	evidence: [],
	summary: "s",
	verdict: "BACKEND_BUG",
}

describe("commandBaseline", () => {
	it("writes a run's findings as known, through the latest link too", async () => {
		const dir = folder()
		const run = savedRun(dir, "2026-10-18T00-00-00Z", { findings: [finding] })
		symlinkSync(run, join(dir, "latest"))
		const out = join(dir, "oat.baseline.json")
		const writer = bufferWriter()
		expect(await commandBaseline(writer, { from: join(dir, "latest"), out })).toBe(0)
		expect(writer.text()).toBe(`  1 known finding → ${out}\n`)
		expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
			entries: [expect.objectContaining({ check: "list.read-after-write" })],
		})
		const two = savedRun(dir, "two", { findings: [finding, { ...finding, entity: "tag" }] })
		const again = bufferWriter()
		expect(await commandBaseline(again, { force: true, from: two, out })).toBe(0)
		expect(again.text()).toContain("2 known findings")
	})

	it("writes oat.baseline.json in the working folder by default", async () => {
		const dir = folder()
		const cwd = process.cwd()
		process.chdir(dir)
		try {
			expect(await commandBaseline(bufferWriter(), { from: savedRun(dir, "run", { findings: [] }) })).toBe(0)
			expect(readFileSync(join(dir, "oat.baseline.json"), "utf8")).toContain('"entries"')
		} finally {
			process.chdir(cwd)
		}
	})

	it("refuses without a run, with an unreadable or listless report, and over an existing file", async () => {
		const dir = folder()
		const refusals: Array<[Record<string, string | true>, RegExp]> = [
			[{}, /^oat: baseline needs --from/],
			[{ from: join(dir, "missing") }, /^oat: cannot read .*oat-report\.json: /],
			[{ from: savedRun(dir, "empty", { findings: "none" }) }, /holds no findings list/],
			[
				{ from: savedRun(dir, "ok", { findings: [] }), out: json(dir, "taken.json", "{}") },
				/exists; --force overwrites it/,
			],
		]
		for (const [flags, said] of refusals) {
			const writer = bufferWriter()
			expect(await commandBaseline(writer, flags)).toBe(2)
			expect(writer.text()).toMatch(said)
		}
	})
})
