import { describe, expect, it } from "vitest"
import { isBytes, PLACEHOLDER, placeholderNames, PRINCIPAL_PLACEHOLDER, WHOLE_PLACEHOLDER } from "./placeholder.ts"

describe("isBytes", () => {
	it("knows a buffer, a typed view and a blob, and nothing else", () => {
		expect(isBytes(new ArrayBuffer(2))).toBe(true)
		expect(isBytes(new Uint8Array([1]))).toBe(true)
		expect(isBytes(new Blob(["x"]))).toBe(true)
		expect(isBytes("x")).toBe(false)
		expect(isBytes({ length: 1 })).toBe(false)
	})
})

describe("placeholderNames", () => {
	it("is every `{name}` in the text of a value, deep through arrays and objects, bytes left out", () => {
		const bytes = new TextEncoder().encode("{inside}")
		expect(placeholderNames({ a: ["{x}", 1, null], b: { c: "/u/{user-id}/{x}" }, raw: bytes })).toEqual([
			"x",
			"user-id",
			"x",
		])
	})

	it("reads a hyphen only between letters, digits and underscores, and a dot not at all", () => {
		expect(placeholderNames("{-a} {a-} {a--b} {} {principal.email} {a_b-c-1}")).toEqual(["a_b-c-1"])
	})
})

describe("the three patterns", () => {
	it("spell one name alike", () => {
		const names = ["user-id", "a_b-c-1", "-a", "a-", "a--b", "a.b", ""]
		const read = (pattern: RegExp, text: (name: string) => string): boolean[] =>
			names.map((name) => [...text(name).matchAll(new RegExp(pattern.source, "g"))].length === 1)
		const plain = read(PLACEHOLDER, (name) => `{${name}}`)
		expect(plain).toEqual([true, true, false, false, false, false, false])
		expect(read(WHOLE_PLACEHOLDER, (name) => `{${name}}`)).toEqual(plain)
		expect(read(PRINCIPAL_PLACEHOLDER, (name) => `{principal.${name}}`)).toEqual(plain)
	})
})
