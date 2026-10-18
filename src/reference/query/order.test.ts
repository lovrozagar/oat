import { describe, expect, it } from "vitest"
import { ROW } from "../model/row.ts"
import { context } from "./__fixtures__/context.ts"
import { parseOrder } from "./order.ts"

const key = (field: string, descending: boolean, nullsFirst: boolean, asText = false) => ({
	asText,
	descending,
	field,
	nullsFirst,
})

const amount = (defects: Parameters<typeof context>[0]) => parseOrder("amount,label", context(defects, {}, ROW))

describe("parseOrder: terms", () => {
	it("reads each key's direction and null placement, nulls first ascending by default", () => {
		expect(parseOrder("name,position.desc", context())).toEqual([
			key("name", false, true),
			key("position", true, false),
		])
		expect(parseOrder("name.asc.nullslast,description.desc.nullsfirst", context())).toEqual([
			key("name", false, false),
			key("description", true, true),
		])
		expect(parseOrder("", context())).toEqual([])
	})

	it("places nulls last by default where the convention says so, reversed when descending", () => {
		expect(parseOrder("name,position.desc", context([], { nulls: "last" }))).toEqual([
			key("name", false, false),
			key("position", true, true),
		])
	})

	it("refuses a field that is not sortable, dropping only a nonexistent one under the defect", () => {
		expect(() => parseOrder("nosuch.asc", context())).toThrow('field "nosuch" is not sortable')
		expect(parseOrder("nosuch.asc,name", context(["SORT_UNKNOWN_FIELD_IGNORED"]))).toEqual([key("name", false, true)])
		expect(() => parseOrder("project_id", context(["SORT_UNKNOWN_FIELD_IGNORED"]))).toThrow(
			'field "project_id" is not sortable',
		)
		expect(() => parseOrder("created_at", context(["SPEC_OVERCLAIMS_SORTABLE"]))).toThrow(
			'field "created_at" is not sortable',
		)
	})

	it("refuses a modifier it does not know, or reads it as no direction under the defect", () => {
		expect(() => parseOrder("name.sideways", context())).toThrow('unknown sort modifier "sideways"')
		expect(parseOrder("name.sideways", context(["IGNORES_BAD_SORT_DIRECTION"]))).toEqual([key("name", false, true)])
	})
})

describe("parseOrder: defects", () => {
	it("ignores nulls modifiers under the defect", () => {
		expect(parseOrder("name.desc.nullsfirst", context(["SORT_NULLS_MODIFIER_IGNORED"]))).toEqual([
			key("name", true, false),
		])
	})

	it("orders numbers as text under either numeric defect, and text as text regardless", () => {
		expect(amount([])).toEqual([key("amount", false, true), key("label", false, true)])
		expect(amount(["SORT_NUMERIC_AS_TEXT"])[0]).toEqual(key("amount", false, true, true))
		expect(amount(["NUMERIC_COMPARED_AS_TEXT"])[0]).toEqual(key("amount", false, true, true))
		expect(amount(["NUMERIC_COMPARED_AS_TEXT"])[1]).toEqual(key("label", false, true))
	})

	it("keeps only the first key under the defect", () => {
		expect(parseOrder("name,position", context(["SORT_MULTI_KEY_IGNORED"]))).toEqual([key("name", false, true)])
	})

	it("reads the server's own default order with no request defect applied", () => {
		const defects = context(["SORT_MULTI_KEY_IGNORED", "SPEC_OVERCLAIMS_SORTABLE", "SORT_NUMERIC_AS_TEXT"])
		expect(parseOrder("created_at.desc,position", defects, true)).toEqual([
			key("created_at", true, false),
			key("position", false, true),
		])
	})
})
