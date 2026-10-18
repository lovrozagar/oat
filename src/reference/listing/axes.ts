import type { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import type { ListingRequest } from "./types.ts"

/**
 * Which axes a request combines. Each FILTER_DROPPED_WHEN_* defect keeps the filter while it is
 * alone and drops it once its named combination is present — the combination is the bug.
 */
export interface Axes {
	sorted: boolean
	selected: boolean
	searched: boolean
}

/* Each defect and the axes that, all present, drop the filter. */
const FILTER_DROPS: ReadonlyArray<readonly [DefectName, ReadonlyArray<keyof Axes>]> = [
	["FILTER_DROPPED_WHEN_SORTED_SEARCHED_AND_SELECTED", ["sorted", "searched", "selected"]],
	["FILTER_DROPPED_WHEN_SORTED", ["sorted"]],
	["FILTER_DROPPED_WHEN_SELECTED", ["selected"]],
	["FILTER_DROPPED_WHEN_SEARCHED", ["searched"]],
	["FILTER_DROPPED_WHEN_SORTED_AND_SELECTED", ["sorted", "selected"]],
	["FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED", ["sorted", "searched"]],
	["FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED", ["searched", "selected"]],
]

export function axesOf(request: ListingRequest): Axes {
	return {
		searched: request.q !== undefined && request.q.trim() !== "",
		selected: request.select !== undefined && request.select !== "" && request.select !== "*",
		sorted: request.order !== undefined && request.order !== "",
	}
}

export function filterDropped(defects: DefectSet, axes: Axes): boolean {
	return FILTER_DROPS.some(([name, needs]) => defects.has(name) && needs.every((axis) => axes[axis]))
}
