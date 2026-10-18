import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { folder } from "../__fixtures__/files.ts"
import { fakeToolkit } from "../__fixtures__/toolkit.ts"
import { aggregate, writeProven } from "./conformance-proven.ts"

/* A sharded self-test: each leg's proven checks on disk, and their union judged at the end. */

describe("writeProven", () => {
	it("writes the legs and their proven checks, sorted, making the folder", () => {
		const path = join(folder(), "deep", "leg.json")
		writeProven(path, ["passes"], new Set(["b", "a"]))
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ legs: ["passes"], proven: ["a", "b"] })
	})
})

describe("aggregate", () => {
	it("passes when every check some leg proved covers the registry", () => {
		const dir = folder()
		writeProven(join(dir, "a.json"), ["passes"], new Set(["check.a"]))
		writeProven(join(dir, "b.json"), ["recall"], new Set(["check.b"]))
		writeFileSync(join(dir, "notes.txt"), "not a leg")
		writeFileSync(join(dir, "c.json"), "{}")
		const writer = bufferWriter()
		expect(aggregate(writer, fakeToolkit({ unproven: ["check.a", "check.b"] }).toolkit, dir)).toBe(0)
		expect(writer.text()).toContain("3 leg file(s) · 2 check(s) proven")
	})

	it("fails on a check no leg proved", () => {
		const dir = folder()
		writeProven(join(dir, "a.json"), ["passes"], new Set(["check.a"]))
		expect(aggregate(bufferWriter(), fakeToolkit({ unproven: ["check.z"] }).toolkit, dir)).toBe(1)
	})

	it("refuses a folder it cannot read, or one with no leg files", () => {
		const missing = bufferWriter()
		expect(aggregate(missing, fakeToolkit().toolkit, join(folder(), "gone"))).toBe(2)
		expect(missing.text()).toMatch(/^oat: cannot read .*gone: /)
		const empty = bufferWriter()
		expect(aggregate(empty, fakeToolkit().toolkit, folder())).toBe(2)
		expect(empty.text()).toContain("holds no proven-check files")
	})
})
