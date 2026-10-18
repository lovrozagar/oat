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
		expect(parseSearch(" alpha \t beta ", "contains", { defects: new DefectSet(), entity: TABLE })).toEqual({
			children: [token("alpha"), token("beta")],
			kind: "and",
		})
		expect(parseSearch("al", "prefix", { defects: new DefectSet(), entity: ROW })).toEqual({
			children: [{ caseSensitive: false, fields: ["label", "note"], kind: "search", mode: "prefix", token: "al" }],
			kind: "and",
		})
	})

	it("matches everything for a blank query, or nothing under the defect", () => {
		expect(parseSearch("  ", "contains", { defects: new DefectSet(), entity: TABLE })).toBeNull()
		expect(
			parseSearch("", "contains", { defects: new DefectSet(["SEARCH_EMPTY_MATCHES_NONE"]), entity: TABLE }),
		).toEqual({
			kind: "const",
			value: false,
		})
	})

	it("matches everything on an entity with nothing searchable", () => {
		const unsearchable: EntityDef = { ...TABLE, fields: TABLE.fields.filter((field) => field.searchable !== true) }
		expect(parseSearch("alpha", "contains", { defects: new DefectSet(), entity: unsearchable })).toBeNull()
	})

	it("keeps only the first token, or matches case-sensitively, under the defects", () => {
		expect(
			parseSearch("a b", "contains", { defects: new DefectSet(["SEARCH_ONLY_FIRST_TOKEN"]), entity: TABLE }),
		).toEqual({
			children: [token("a")],
			kind: "and",
		})
		expect(parseSearch("A", "contains", { defects: new DefectSet(["SEARCH_CASE_SENSITIVE"]), entity: TABLE })).toEqual({
			children: [token("A", { caseSensitive: true })],
			kind: "and",
		})
	})
})
