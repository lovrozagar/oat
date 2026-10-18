import { describe, expect, it } from "vitest"
import { parseSortGrammar } from "./sort-parse.ts"
import { renderSortKey, renderSortKeys, renderUnknownDirection, SORT_PRESETS, type SortGrammarSpec } from "./sort.ts"

/*
 * A sort grammar oat has no name for, declared as a template: `Qty_descending`, several keys
 * joined by a comma or none at all, and a nulls token only when the grammar has one.
 */
const TEMPLATE = { asc: "ascending", desc: "descending", join: ",", term: "{field}_{direction}" }

function parsed(raw: unknown): SortGrammarSpec {
	const result = parseSortGrammar(raw)
	if (!result.ok) throw new Error(result.error)
	return result.spec
}

const keys = [
	["Qty", "desc"],
	["Name", "asc"],
] as const

describe("a template sort grammar", () => {
	it("writes each key with its own direction tokens", () => {
		const spec = parsed(TEMPLATE)
		expect(renderSortKey(spec, { direction: "desc", field: "Qty" })).toBe("Qty_descending")
		expect(renderSortKey(spec, { direction: "asc", field: "Qty" })).toBe("Qty_ascending")
		expect(renderSortKeys(spec, keys)).toBe("Qty_descending,Name_ascending")
	})

	it("sorts by one key only when it has no joiner", () => {
		const spec = parsed({ ...TEMPLATE, join: null })
		expect(renderSortKeys(spec, [["Qty", "desc"]])).toBe("Qty_descending")
		expect(renderSortKeys(spec, keys)).toBeNull()
		expect(renderSortKeys(spec, [])).toBeNull()
	})

	it("appends a nulls token only when it declares one", () => {
		expect(renderSortKey(parsed(TEMPLATE), { direction: "asc", field: "Qty", nulls: "first" })).toBe("Qty_ascending")
		const withNulls = parsed({ ...TEMPLATE, nulls: { first: "_nf", last: "_nl" } })
		expect(renderSortKey(withNulls, { direction: "asc", field: "Qty", nulls: "last" })).toBe("Qty_ascending_nl")
		expect(renderSortKey(withNulls, { direction: "asc", field: "Qty" })).toBe("Qty_ascending")
	})
})

describe("the named sort grammars", () => {
	it("join several keys with a comma, as before", () => {
		const both = [
			["a", "asc"],
			["b", "desc"],
		] as const
		expect(renderSortKeys(SORT_PRESETS.dotted, both)).toBe("a.asc,b.desc")
		expect(renderSortKeys(SORT_PRESETS.prefixed, both)).toBe("a,-b")
		expect(renderSortKeys(SORT_PRESETS.colon, both)).toBe("a:asc,b:desc")
		expect(renderSortKeys(SORT_PRESETS.spaced, both)).toBe("a asc,b desc")
		expect(renderSortKey(SORT_PRESETS.dotted, { direction: "asc", field: "a", nulls: "last" })).toBe("a.asc.nullslast")
	})
})

/*
 * Some APIs take several sort keys only as the sort parameter repeated, in order:
 * `?sort=A_descending&sort=B_ascending`. `join: "repeat"` declares it; the keys then travel as a
 * list the client sends one parameter each, never joined into one value.
 */
describe("join: repeat", () => {
	it("renders several keys as a list, in order, and one key as a value", () => {
		const spec = parsed({ ...TEMPLATE, join: "repeat" })
		expect(renderSortKeys(spec, keys)).toEqual(["Qty_descending", "Name_ascending"])
		expect(renderSortKeys(spec, [["A", "desc"]])).toBe("A_descending")
	})
})

describe("an unknown direction", () => {
	it("swaps the direction token, unless ascending has none of its own", () => {
		expect(renderUnknownDirection(SORT_PRESETS.dotted, "a", "sideways")).toBe("a.sideways")
		expect(renderUnknownDirection(SORT_PRESETS.prefixed, "a", "~")).toBeNull()
		expect(renderUnknownDirection({ ...TEMPLATE, desc: "" }, "a", "~")).toBeNull()
	})
})
