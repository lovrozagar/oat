import { describe, expect, it } from "vitest"
import { entityList, formatBytes, named, slug, truncate, wrap } from "./text.ts"

describe("slug", () => {
	it("keeps lowercase words joined by single dashes, at most 60 characters", () => {
		expect(slug("Row-Sort.Order is applied!")).toBe("row-sort-order-is-applied")
		expect(slug("--a--")).toBe("a")
		expect(slug("x".repeat(80))).toHaveLength(60)
	})
})

describe("truncate", () => {
	it("keeps text as is and writes anything else as indented JSON", () => {
		expect(truncate("plain")).toBe("plain")
		expect(truncate({ a: 1 })).toBe('{\n  "a": 1\n}')
	})

	it("cuts what is longer than the limit and counts the rest", () => {
		expect(truncate("abcdef", 4)).toBe("abcd\n… 2 more characters")
		expect(truncate("x".repeat(600))).toBe("x".repeat(600))
	})
})

describe("wrap", () => {
	it("breaks at whitespace so no line passes the width", () => {
		expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"])
		expect(wrap("", 10)).toEqual([])
	})

	it("starts with an empty line when the first word alone is too wide", () => {
		expect(wrap("unbreakable", 4)).toEqual(["", "unbreakable"])
	})
})

describe("entityList", () => {
	it("names a few entities and counts many", () => {
		expect(entityList([])).toBe("none")
		expect(entityList(["a", "b"])).toBe("a, b")
		expect(entityList(Array.from({ length: 12 }, (_, i) => `e${i}`))).toContain("e11")
		expect(entityList(Array.from({ length: 13 }, (_, i) => `e${i}`))).toBe("13 entities")
	})
})

describe("named", () => {
	it("lists up to `keep` names and counts the rest", () => {
		expect(named(["a", "b"])).toBe("a, b")
		expect(named(["a", "b", "c"], 2)).toBe("a, b +1 more")
	})
})

describe("formatBytes", () => {
	it("picks bytes, KB or MB", () => {
		expect(formatBytes(1023)).toBe("1023 bytes")
		expect(formatBytes(1536)).toBe("1.5 KB")
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB")
	})
})
