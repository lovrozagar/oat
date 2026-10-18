import { describe, expect, it } from "vitest"
import { decodeSegment, resolvePointer } from "./pointer.ts"

const doc = {
	a: { "b/c": 1, "d~e": 2, "{x}": 3, "%E0%A4%A": 4, list: ["zero", "one"] },
	nothing: null,
}

describe("resolvePointer", () => {
	it("names the document itself with `#` and `#/`", () => {
		expect(resolvePointer(doc, "#")).toBe(doc)
		expect(resolvePointer(doc, "#/")).toBe(doc)
	})

	it("walks escaped, percent-encoded and array segments", () => {
		expect(resolvePointer(doc, "#/a/b~1c")).toBe(1)
		expect(resolvePointer(doc, "#/a/d~0e")).toBe(2)
		expect(resolvePointer(doc, "#/a/%7Bx%7D")).toBe(3)
		expect(resolvePointer(doc, "#/a/%E0%A4%A")).toBe(4)
		expect(resolvePointer(doc, "#/a/list/1")).toBe("one")
	})

	it("is undefined where nothing is: a missing key, or a step through null or a scalar", () => {
		expect(resolvePointer(doc, "#/a/missing")).toBeUndefined()
		expect(resolvePointer(doc, "#/nothing/x")).toBeUndefined()
		expect(resolvePointer(doc, "#/a/b~1c/x")).toBeUndefined()
		expect(resolvePointer(doc, "#/a/toString")).toBeUndefined()
	})
})

describe("decodeSegment", () => {
	it("undoes `~1` and `~0`, then percent-encoding, keeping text that is not valid encoding", () => {
		expect(decodeSegment("a~1b~0c")).toBe("a/b~c")
		expect(decodeSegment("%7Bid%7D")).toBe("{id}")
		expect(decodeSegment("100%")).toBe("100%")
	})
})
