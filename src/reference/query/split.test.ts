import { describe, expect, it } from "vitest"
import { countTerms, GROUP, splitTopLevel } from "./split.ts"

describe("splitTopLevel", () => {
	it("splits on commas outside parentheses, trimming and dropping empty parts", () => {
		expect(splitTopLevel("a, b ,,c")).toEqual(["a", "b", "c"])
		expect(splitTopLevel("and(a,or(b,c)),d")).toEqual(["and(a,or(b,c))", "d"])
		expect(splitTopLevel("")).toEqual([])
	})

	it("counts depth as it goes, so unbalanced parentheses split where the depth is back at zero", () => {
		expect(splitTopLevel(")(,a")).toEqual([")(", "a"])
		expect(splitTopLevel("a,(b,c")).toEqual(["a", "(b,c"])
	})
})

describe("countTerms", () => {
	it("counts a bare term as one and a group as the terms it holds, through every level", () => {
		expect(countTerms("name.eq.x")).toBe(1)
		expect(countTerms(" and(a.eq.1,or(b.eq.2,c.eq.3)) ")).toBe(3)
		expect(countTerms("or()")).toBe(0)
	})
})

describe("GROUP", () => {
	it("captures the combinator and everything inside it", () => {
		expect(GROUP.exec("and(a,b)")?.slice(1)).toEqual(["and", "a,b"])
		expect(GROUP.exec("xor(a)")).toBeNull()
	})
})
