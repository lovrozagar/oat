import { describe, expect, it } from "vitest"
import { acceptableOf, primaryOf } from "./expected.ts"

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
