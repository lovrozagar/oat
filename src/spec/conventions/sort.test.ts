import { describe, expect, it } from "vitest"
import { parseSortGrammar } from "../render/sort-parse.ts"
import { SORT_PRESETS } from "../render/sort.ts"
import { sortKeys, sortSpec, sortTerm, sortTermWithNulls } from "./sort.ts"
import type { QueryConventions, SortGrammar } from "./types.ts"

const at = (sortGrammar: SortGrammar, extra: Partial<QueryConventions> = {}): QueryConventions => ({
	envelope: {},
	grammar: "postgrest",
	selectGrammar: "csv",
	sortGrammar,
	...extra,
})

const parsed = parseSortGrammar({ asc: "up", desc: "down", join: "repeat", term: "{field}_{direction}" })
if (!parsed.ok) throw new Error(parsed.error)
const template = at("template", { sortSpec: parsed.spec })

describe("sortSpec", () => {
	it("is a named grammar's preset, or the declared template", () => {
		expect(sortSpec(at("colon"))).toBe(SORT_PRESETS.colon)
		expect(sortSpec(template)).toBe(parsed.spec)
	})

	it("refuses a template grammar that lost its template", () => {
		expect(() => sortSpec(at("template"))).toThrow("a template sort grammar without its template")
	})
})

describe("sort terms", () => {
	it("render one key in the endpoint's grammar", () => {
		expect(sortTerm(at("prefixed"), "name", "desc")).toBe("-name")
		expect(sortTerm(at("dotted"), "name", "asc", "last")).toBe("name.asc.nullslast")
		expect(sortTerm(template, "name", "desc")).toBe("name_down")
	})

	it("place nulls only in a grammar with a token for it", () => {
		expect(sortTermWithNulls(at("dotted"), "name", "desc", "first")).toBe("name.desc.nullsfirst")
		expect(sortTermWithNulls(at("spaced"), "name", "desc", "first")).toBeNull()
	})

	it("render several keys as one value, or one per parameter for a repeated grammar", () => {
		const keys = [
			["a", "asc"],
			["b", "desc"],
		] as const
		expect(sortKeys(at("dotted"), keys)).toBe("a.asc,b.desc")
		expect(sortKeys(template, keys)).toEqual(["a_up", "b_down"])
	})
})
