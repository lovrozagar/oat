import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { TABLE } from "../model/table.ts"
import type { Paging } from "./params.ts"
import { cursorOffset, cut, filteredWindow, invert, numberedStart } from "./window.ts"

const ROWS = ["a", "b", "c", "d", "e"].map((id) => ({ id }))
const defects = (...names: DefectName[]) => new DefectSet(names)
const paging = (page: number | undefined, offset: number | undefined, servedLimit = 2): Paging => ({
	offset,
	page,
	servedLimit,
})

describe("invert", () => {
	it("swaps the two collations", () => {
		expect([invert("binary"), invert("insensitive")]).toEqual(["insensitive", "binary"])
	})
})

describe("cursorOffset", () => {
	it("starts just past the row the cursor names, or on it under the drift", () => {
		expect(cursorOffset(ROWS, "b", TABLE, defects())).toBe(2)
		expect(cursorOffset(ROWS, "b", TABLE, defects("CURSOR_DRIFT"))).toBe(1)
	})

	it("refuses a cursor naming no row of the collection", () => {
		expect(() => cursorOffset(ROWS, "z", TABLE, defects())).toThrow("cursor does not point into this collection")
	})
})

describe("numberedStart", () => {
	it("starts at the offset asked, one late past the first under the defect", () => {
		expect(numberedStart(paging(undefined, 3), 5, defects())).toEqual({ offset: 3, page: null })
		expect(numberedStart(paging(undefined, 3), 5, defects("OFF_BY_ONE_PAGE"))).toEqual({ offset: 4, page: null })
		expect(numberedStart(paging(undefined, 0), 5, defects("OFF_BY_ONE_PAGE"))).toEqual({ offset: 0, page: null })
	})

	it("starts a numbered page at its first row, page one by default, one late past it under the defect", () => {
		expect(numberedStart(paging(undefined, undefined), 5, defects())).toEqual({ offset: 0, page: 1 })
		expect(numberedStart(paging(3, undefined), 5, defects())).toEqual({ offset: 4, page: 3 })
		expect(numberedStart(paging(3, undefined), 5, defects("OFF_BY_ONE_PAGE"))).toEqual({ offset: 5, page: 3 })
		expect(numberedStart(paging(1, undefined), 5, defects("OFF_BY_ONE_PAGE"))).toEqual({ offset: 0, page: 1 })
	})

	it("serves the last page again for one past the end, under the defect, where there are rows", () => {
		expect(numberedStart(paging(9, undefined), 5, defects("PAGE_PAST_END_REPEATS"))).toEqual({ offset: 4, page: 9 })
		expect(numberedStart(paging(2, undefined), 5, defects("PAGE_PAST_END_REPEATS"))).toEqual({ offset: 2, page: 2 })
		expect(numberedStart(paging(9, undefined), 0, defects("PAGE_PAST_END_REPEATS"))).toEqual({ offset: 16, page: 9 })
	})
})

describe("cut", () => {
	it("takes the page's rows, or every row from its start when the limit is ignored", () => {
		expect(cut(ROWS, { offset: 1, page: null }, 2, defects())).toEqual([{ id: "b" }, { id: "c" }])
		expect(cut(ROWS, { offset: 1, page: null }, 2, defects("LIMIT_IGNORED"))).toHaveLength(4)
	})
})

describe("filteredWindow", () => {
	it("keeps the window's rows the predicate matched", () => {
		expect(filteredWindow(ROWS.slice(0, 3), [{ id: "c" }, { id: "e" }], TABLE, defects())).toEqual([{ id: "c" }])
		expect(filteredWindow(ROWS.slice(0, 2), [{ id: "e" }], TABLE, defects())).toEqual([])
	})

	it("serves the unfiltered window when the result would be empty, under the guard", () => {
		const window = ROWS.slice(0, 2)
		expect(filteredWindow(window, [{ id: "e" }], TABLE, defects("EMPTY_RESULT_RETURNS_ALL"))).toBe(window)
		expect(filteredWindow(window, [{ id: "a" }], TABLE, defects("EMPTY_RESULT_RETURNS_ALL"))).toEqual([{ id: "a" }])
	})
})
