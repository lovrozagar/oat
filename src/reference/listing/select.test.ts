import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import { checkSelect, NESTED, nestedFields, selectEntries, wholeRow } from "./select.ts"

const check =
	(select: string | undefined, defects: DefectName[] = [], entity = TABLE) =>
	() =>
		checkSelect(select, entity, new DefectSet(defects))

describe("the sparse fieldset grammar", () => {
	it("serves the whole row for no fieldset, an empty one or *", () => {
		expect([undefined, "", "*"].map(wholeRow)).toEqual([true, true, true])
		expect(wholeRow("id")).toBe(false)
	})

	it("splits entries on top-level commas and reads a nested entry's fields", () => {
		expect(selectEntries(" id , table(name, status),,x")).toEqual(["id", "table(name, status)", "x"])
		expect(NESTED.exec("table(name, status)")?.slice(1)).toEqual(["table", "name, status"])
		expect(nestedFields("name, status")).toEqual(["name", "status"])
	})
})

describe("checkSelect", () => {
	it("accepts the whole row, declared fields and declared relations", () => {
		expect(check(undefined)).not.toThrow()
		expect(check("id,name")).not.toThrow()
		expect(check("id,table(name,status)", [], ROW)).not.toThrow()
	})

	it("refuses a relation the entity lacks or a field the relation does not offer", () => {
		expect(check("table(name)")).toThrow('"table(name)" is not a selectable relation')
		expect(check("table(id)", [], ROW)).toThrow('"table(id)" is not a selectable relation')
	})

	it("refuses an unknown field where the catalog says so, unless the defect ignores it", () => {
		expect(check("id,bogus")).toThrow('field "bogus" is not selectable')
		expect(check("id,bogus", ["SELECT_UNKNOWN_IGNORED"])).not.toThrow()
		expect(check("id,bogus", [], ROW)).not.toThrow()
	})

	it("refuses the overclaimed field under the overclaim", () => {
		expect(check("created_at", ["SPEC_OVERCLAIMS_SELECTABLE"])).toThrow('field "created_at" is not selectable')
		expect(check("name", ["SPEC_OVERCLAIMS_SELECTABLE"])).not.toThrow()
	})
})
