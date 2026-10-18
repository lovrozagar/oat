import { describe, expect, it } from "vitest"
import { describeSortGrammar, parseSortGrammar } from "./sort-parse.ts"
import { SORT_PRESETS } from "./sort.ts"

const TEMPLATE = { asc: "ascending", desc: "descending", join: ",", term: "{field}_{direction}" }

describe("parseSortGrammar", () => {
	it("reads the template form, joining with a comma by default", () => {
		expect(parseSortGrammar({ asc: "", desc: "-", term: "{direction}{field}" })).toEqual({
			ok: true,
			spec: { asc: "", desc: "-", join: ",", term: "{direction}{field}" },
		})
		expect(parseSortGrammar({ ...TEMPLATE, join: null, nulls: { first: "_nf", last: "_nl" } })).toEqual({
			ok: true,
			spec: { ...TEMPLATE, join: null, nulls: { first: "_nf", last: "_nl" } },
		})
	})

	it("names the key it cannot read", () => {
		for (const [raw, key] of [
			["dotted", "sortGrammar"],
			[{ ...TEMPLATE, term: "" }, "term"],
			[{ ...TEMPLATE, term: "{field}" }, "term"],
			[{ ...TEMPLATE, term: "{direction}" }, "term"],
			[{ ...TEMPLATE, asc: 1 }, "asc"],
			[{ ...TEMPLATE, asc: "x", desc: "x" }, "desc"],
			[{ ...TEMPLATE, desc: "" }, "desc"],
			[{ ...TEMPLATE, join: "" }, "join"],
			[{ ...TEMPLATE, join: 1 }, "join"],
			[{ ...TEMPLATE, nulls: { first: "a" } }, "nulls"],
			[{ ...TEMPLATE, nulls: "first" }, "nulls"],
			[{ ...TEMPLATE, nulls: { first: "", last: "b" } }, "nulls"],
		] as const) {
			const result = parseSortGrammar(raw)
			expect(result.ok, key).toBe(false)
			expect(result.ok ? "" : result.error, key).toContain(key)
		}
	})
})

describe("describeSortGrammar", () => {
	it("says how keys are written and joined", () => {
		expect(describeSortGrammar(TEMPLATE)).toBe('template {field}_{direction}  asc ascending  desc descending  join ","')
		expect(describeSortGrammar(SORT_PRESETS.prefixed)).toBe('template {direction}{field}  asc (bare)  desc -  join ","')
		expect(describeSortGrammar({ ...TEMPLATE, join: null })).toContain("one key only")
		expect(describeSortGrammar({ ...TEMPLATE, join: "repeat" })).toContain("several keys as the parameter repeated")
		expect(describeSortGrammar(SORT_PRESETS.dotted)).toContain("nulls .nullsfirst / .nullslast")
	})
})
