import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { type Axes, axesOf, filterDropped } from "./axes.ts"

const all: Axes = { searched: true, selected: true, sorted: true }
const only = (axis: keyof Axes): Axes => ({ searched: false, selected: false, sorted: false, [axis]: true })
const drops = (defect: DefectName, axes: Axes): boolean => filterDropped(new DefectSet([defect]), axes)

describe("axesOf", () => {
	it("counts an axis as present only when it asks for something", () => {
		expect(axesOf({})).toEqual({ searched: false, selected: false, sorted: false })
		expect(axesOf({ order: "", q: "  ", select: "*" })).toEqual({ searched: false, selected: false, sorted: false })
		expect(axesOf({ order: "name", q: "a", select: "id" })).toEqual(all)
		expect(axesOf({ select: "" }).selected).toBe(false)
	})
})

describe("filterDropped", () => {
	it("keeps the filter on a correct backend whatever joins it", () => {
		expect(filterDropped(new DefectSet(), all)).toBe(false)
	})

	it("drops it once each defect's own axis joins", () => {
		expect(drops("FILTER_DROPPED_WHEN_SORTED", only("sorted"))).toBe(true)
		expect(drops("FILTER_DROPPED_WHEN_SELECTED", only("selected"))).toBe(true)
		expect(drops("FILTER_DROPPED_WHEN_SEARCHED", only("searched"))).toBe(true)
		expect(drops("FILTER_DROPPED_WHEN_SORTED", only("searched"))).toBe(false)
	})

	it("drops it only once every axis a combination names is present", () => {
		expect(drops("FILTER_DROPPED_WHEN_SORTED_AND_SELECTED", { ...only("sorted"), selected: true })).toBe(true)
		expect(drops("FILTER_DROPPED_WHEN_SORTED_AND_SELECTED", only("sorted"))).toBe(false)
		expect(drops("FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED", { ...only("sorted"), searched: true })).toBe(true)
		expect(drops("FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED", { ...only("searched"), selected: true })).toBe(true)
		expect(drops("FILTER_DROPPED_WHEN_SORTED_SEARCHED_AND_SELECTED", all)).toBe(true)
		expect(drops("FILTER_DROPPED_WHEN_SORTED_SEARCHED_AND_SELECTED", { ...all, searched: false })).toBe(false)
	})
})
