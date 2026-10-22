import { describe, expect, it } from "vitest"
import { CATALOG_DEFECTS } from "./catalog.ts"
import { COMPOSITION_DEFECTS } from "./composition.ts"
import { CORE_DEFECTS } from "./core.ts"
import { QUERY_DEFECTS } from "./query.ts"
import { RECORD_DEFECTS } from "./records.ts"
import { SECURITY_DEFECTS } from "./security.ts"
import { DEFECTS, isDefectName } from "./table.ts"

describe("DEFECTS", () => {
	it("merges the families in order, so every reader sees one stable name order", () => {
		const families = [
			CORE_DEFECTS,
			COMPOSITION_DEFECTS,
			QUERY_DEFECTS,
			RECORD_DEFECTS,
			CATALOG_DEFECTS,
			SECURITY_DEFECTS,
		]
		expect(Object.keys(DEFECTS)).toEqual(families.flatMap((family) => Object.keys(family)))
		expect(Object.keys(DEFECTS)).toHaveLength(132)
		expect(DEFECTS.UNSTABLE_SORT).toBe(CORE_DEFECTS.UNSTABLE_SORT)
	})

	it("names no defect twice across the families", () => {
		const families = [
			CORE_DEFECTS,
			COMPOSITION_DEFECTS,
			QUERY_DEFECTS,
			RECORD_DEFECTS,
			CATALOG_DEFECTS,
			SECURITY_DEFECTS,
		]
		const total = families.reduce((sum, family) => sum + Object.keys(family).length, 0)
		expect(total).toBe(Object.keys(DEFECTS).length)
	})
})

describe("isDefectName", () => {
	it("accepts every defect's name", () => {
		expect(Object.keys(DEFECTS).every(isDefectName)).toBe(true)
	})

	it("refuses anything else, an object's own inherited keys included", () => {
		for (const name of ["", "unstable_sort", " UNSTABLE_SORT", "NOPE", "constructor", "toString", "__proto__"]) {
			expect(isDefectName(name)).toBe(false)
		}
	})
})
