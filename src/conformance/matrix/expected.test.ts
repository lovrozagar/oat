import { describe, expect, it } from "vitest"
import type { Finding } from "../../runtime/finding.ts"
import { acceptableOf, judgedOperations, primaryOf } from "./expected.ts"

describe("an EXPECTED row", () => {
	it("is its own primary and only acceptable check when it names one", () => {
		expect(primaryOf("list.read-after-write")).toBe("list.read-after-write")
		expect(acceptableOf("list.read-after-write")).toEqual(["list.read-after-write"])
	})

	it("leads with its primary when it names several, all acceptable", () => {
		expect(primaryOf(["a.one", "b.two"])).toBe("a.one")
		expect(acceptableOf(["a.one", "b.two"])).toEqual(["a.one", "b.two"])
	})

	it("has no primary when it names none", () => {
		expect(primaryOf([])).toBe("")
	})
})

const finding = (check: string, operations?: string[]): Finding => ({
	check,
	detail: "d",
	entity: "note",
	evidence: [],
	summary: "s",
	verdict: "BACKEND_BUG",
	...(operations === undefined ? {} : { operations }),
})

describe("judgedOperations", () => {
	it("is every operation the check judged, once each, and none from a run-level finding", () => {
		const findings = [
			finding("list.read-after-write", ["note.list", "note.read"]),
			finding("other.check", ["note.update"]),
			finding("list.read-after-write"),
			finding("list.read-after-write", ["note.list"]),
		]
		expect(judgedOperations(findings, "list.read-after-write")).toEqual(["note.list", "note.read"])
		expect(judgedOperations(findings, null)).toEqual([])
	})
})
