import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import { DEFAULT_CONVENTIONS } from "../query/conventions.ts"
import { integerParam, nearestLimit, pagingOf } from "./params.ts"
import type { ListingRequest } from "./types.ts"

const paging = (request: ListingRequest, defects: DefectName[] = [], clampLimit?: number) =>
	pagingOf({ defects: new DefectSet(defects), entity: TABLE }, request, {
		clampLimit,
		conventions: DEFAULT_CONVENTIONS,
		scope: {},
	})

describe("integerParam", () => {
	it("reads an absent parameter as absent and an integer in range as itself", () => {
		expect(integerParam(undefined, "page", { min: 1 })).toBeUndefined()
		expect(integerParam("3", "page", { max: 5, min: 1 })).toBe(3)
	})

	it("refuses blank, fractional and out-of-range text, naming the range", () => {
		for (const raw of ["", " ", "2.5", "x", "0"]) {
			expect(() => integerParam(raw, "page", { min: 1 })).toThrow('query parameter "page" must be an integer >= 1')
		}
		expect(() => integerParam("6", "limit", { max: 5, min: 1 })).toThrow(
			'query parameter "limit" must be an integer between 1 and 5',
		)
	})
})

describe("nearestLimit", () => {
	it("moves a page size into the published range instead of refusing it", () => {
		expect(nearestLimit(undefined, 5)).toBeUndefined()
		expect(nearestLimit("0", 5)).toBe(1)
		expect(nearestLimit("-4", 5)).toBe(1)
		expect(nearestLimit("50", 5)).toBe(5)
		expect(nearestLimit("50", undefined)).toBe(50)
		/* A lifted ceiling (LIMIT_EXCEEDS_MAX) leaves the floor where it is. */
		expect(nearestLimit("0", undefined)).toBe(1)
		expect(nearestLimit("-4", undefined)).toBe(1)
		expect(() => nearestLimit("x", 5)).toThrow('query parameter "limit" must be an integer')
	})
})

describe("pagingOf", () => {
	it("serves the default size, and refuses one past the published maximum", () => {
		expect(paging({})).toEqual({ offset: undefined, page: undefined, servedLimit: 20 })
		expect(paging({ limit: "100", offset: "4", page: "2" })).toEqual({ offset: 4, page: 2, servedLimit: 100 })
		expect(() => paging({ limit: "101" })).toThrow("between 1 and 100")
		expect(() => paging({ limit: "0", page: "0" })).toThrow('"limit"')
	})

	it("serves more than the maximum under the defect, and the nearest size under the other", () => {
		expect(paging({ limit: "500" }, ["LIMIT_EXCEEDS_MAX"]).servedLimit).toBe(500)
		expect(paging({ limit: "500" }, ["LIMIT_OUT_OF_RANGE_SERVED"]).servedLimit).toBe(100)
		expect(paging({ limit: "0" }, ["LIMIT_OUT_OF_RANGE_SERVED"]).servedLimit).toBe(1)
	})

	it("keeps the floor of 1 under LIMIT_OUT_OF_RANGE_SERVED whichever way the ceiling goes missing", () => {
		expect(paging({ limit: "0" }, ["LIMIT_OUT_OF_RANGE_SERVED", "LIMIT_EXCEEDS_MAX"]).servedLimit).toBe(1)
		expect(paging({ limit: "-4" }, ["LIMIT_OUT_OF_RANGE_SERVED"], 3).servedLimit).toBe(1)
	})

	it("clamps silently to an undocumented ceiling instead of refusing", () => {
		expect(paging({ limit: "500" }, [], 3).servedLimit).toBe(3)
		expect(paging({ limit: "2" }, [], 3).servedLimit).toBe(2)
		expect(paging({}, ["LIMIT_EXCEEDS_MAX"], 3).servedLimit).toBe(20)
	})

	it("caps the default at the entity's own maximum", () => {
		expect(
			pagingOf({ defects: new DefectSet(), entity: ROW }, {}, { conventions: DEFAULT_CONVENTIONS, scope: {} })
				.servedLimit,
		).toBe(5)
	})
})
