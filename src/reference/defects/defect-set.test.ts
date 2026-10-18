import { describe, expect, it } from "vitest"
import { DefectSet } from "./defect-set.ts"

describe("DefectSet", () => {
	it("is empty when given nothing: a clean backend", () => {
		const defects = new DefectSet()
		expect(defects.list()).toEqual([])
		expect(defects.has("UNSTABLE_SORT")).toBe(false)
	})

	it("holds the named defects once each, in the order first named", () => {
		const defects = new DefectSet(["STALE_LIST", "UNSTABLE_SORT", "STALE_LIST"])
		expect(defects.list()).toEqual(["STALE_LIST", "UNSTABLE_SORT"])
		expect(defects.has("UNSTABLE_SORT")).toBe(true)
		expect(defects.has("FILTER_IGNORED")).toBe(false)
	})

	it("refuses a name that is no defect, listing every unknown one, so a typo never runs clean", () => {
		expect(() => new DefectSet(["UNSTABLE_SORT", "UNSTABEL_SORT", "constructor"])).toThrow(
			"unknown defect(s): UNSTABEL_SORT, constructor",
		)
	})

	it("hands out a copy of its list", () => {
		const defects = new DefectSet(["STALE_LIST"])
		defects.list().push("UNSTABLE_SORT")
		expect(defects.list()).toEqual(["STALE_LIST"])
	})
})
