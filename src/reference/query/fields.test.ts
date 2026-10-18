import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import { OVERCLAIMED_FIELD } from "../model/fields.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import { fieldOf, filterableFields, isNumeric, sortableFields } from "./fields.ts"

describe("fieldOf", () => {
	it("finds a declared field by name, and nothing for another name", () => {
		expect(fieldOf(TABLE, "name")?.maxLength).toBe(128)
		expect(fieldOf(TABLE, "nope")).toBeUndefined()
	})
})

describe("filterableFields and sortableFields", () => {
	it("are the declared ones on a correct backend", () => {
		expect(filterableFields(TABLE, new DefectSet())).toContain(OVERCLAIMED_FIELD)
		expect(sortableFields(TABLE, new DefectSet())).toContain(OVERCLAIMED_FIELD)
	})

	it("lose the overclaimed field under the overclaim defects, one role each", () => {
		const filterable = filterableFields(TABLE, new DefectSet(["SPEC_OVERCLAIMS_FILTERABLE"]))
		expect(filterable).not.toContain(OVERCLAIMED_FIELD)
		expect(filterable).toContain("name")
		expect(sortableFields(TABLE, new DefectSet(["SPEC_OVERCLAIMS_FILTERABLE"]))).toContain(OVERCLAIMED_FIELD)
		expect(sortableFields(TABLE, new DefectSet(["SPEC_OVERCLAIMS_SORTABLE"]))).not.toContain(OVERCLAIMED_FIELD)
	})
})

describe("isNumeric", () => {
	it("is true for integers and numbers only", () => {
		expect(isNumeric(fieldOf(TABLE, "position"))).toBe(true)
		expect(isNumeric(fieldOf(ROW, "amount"))).toBe(true)
		expect(isNumeric(fieldOf(TABLE, "name"))).toBe(false)
		expect(isNumeric(undefined)).toBe(false)
	})
})
