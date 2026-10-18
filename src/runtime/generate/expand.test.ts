import { describe, expect, it } from "vitest"
import { expand } from "./expand.ts"

describe("expand", () => {
	it("expands literals, anchors and the any-character dot", () => {
		expect(expand("^abc$", 0)).toBe("abc")
		expect(expand("a.c", 0)).toBe("aac")
	})

	it("takes a class's first character, a digit or word class, or a range's start", () => {
		expect(expand("[xyz]", 0)).toBe("x")
		expect(expand("[^xyz]", 0)).toBe("x")
		expect(expand("[\\d]", 7)).toBe("7")
		expect(expand("[\\w]", 0)).toBe("a")
		expect(expand("[a-z]", 0)).toBe("a")
		expect(expand("[]", 0)).toBe("a")
		expect(expand("[a-]", 0)).toBe("a")
	})

	it("cannot expand an unclosed class or group", () => {
		expect(expand("[abc", 0)).toBeUndefined()
		expect(expand("(abc", 0)).toBeUndefined()
	})

	it("reads escapes: digits, word and space classes, and literals", () => {
		expect(expand("\\d\\w\\s\\.", 12)).toBe("2a .")
		expect(expand("ab\\", 0)).toBe("ab")
	})

	it("takes a group's first alternative, and nothing for one it cannot expand", () => {
		expect(expand("(ab|cd)e", 0)).toBe("abe")
		expect(expand("(?:x)y", 0)).toBe("xy")
		expect(expand("([a)b", 0)).toBe("b")
	})

	it("stops at a top-level alternative or a stray close", () => {
		expect(expand("ab|cd", 0)).toBe("ab")
		expect(expand("ab)cd", 0)).toBe("ab")
	})

	it("repeats by quantifier: + twice, * and ? once, {n} n times", () => {
		expect(expand("a+b*c?", 0)).toBe("aabc")
		expect(expand("a{3}b{2,5}c{1,}", 0)).toBe("aaabbc")
	})

	it("gives up lengthening past 512 atoms", () => {
		expect(expand("a".repeat(600), 0)).toBe("a".repeat(512))
	})
})
