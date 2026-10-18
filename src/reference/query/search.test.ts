import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import type { EntityDef } from "../model/types.ts"
import { parseSearch } from "./search.ts"

const token = (value: string, extra: object = {}) => ({
	caseSensitive: false,
	fields: ["name", "slug"],
	kind: "search",
	mode: "contains",
	token: value,
	...extra,
})

describe("parseSearch", () => {
	it("requires every whitespace-separated token in some searchable field", () => {
		expect(parseSearch(" alpha \t beta ", TABLE, new DefectSet(), "contains")).toEqual({
			children: [token("alpha"), token("beta")],
			kind: "and",
		})
		expect(parseSearch("al", ROW, new DefectSet(), "prefix")).toEqual({
			children: [{ caseSensitive: false, fields: ["label", "note"], kind: "search", mode: "prefix", token: "al" }],
			kind: "and",
		})
	})

	it("matches everything for a blank query, or nothing under the defect", () => {
		expect(parseSearch("  ", TABLE, new DefectSet(), "contains")).toBeNull()
		expect(parseSearch("", TABLE, new DefectSet(["SEARCH_EMPTY_MATCHES_NONE"]), "contains")).toEqual({
			kind: "const",
			value: false,
		})
	})

	it("matches everything on an entity with nothing searchable", () => {
		const unsearchable: EntityDef = { ...TABLE, fields: TABLE.fields.filter((field) => field.searchable !== true) }
		expect(parseSearch("alpha", unsearchable, new DefectSet(), "contains")).toBeNull()
	})

	it("keeps only the first token, or matches case-sensitively, under the defects", () => {
		expect(parseSearch("a b", TABLE, new DefectSet(["SEARCH_ONLY_FIRST_TOKEN"]), "contains")).toEqual({
			children: [token("a")],
			kind: "and",
		})
		expect(parseSearch("A", TABLE, new DefectSet(["SEARCH_CASE_SENSITIVE"]), "contains")).toEqual({
			children: [token("A", { caseSensitive: true })],
			kind: "and",
		})
	})
})
