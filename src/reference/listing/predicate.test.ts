import { describe, expect, it } from "vitest"
import type { DefectName } from "../defects/table.ts"
import { ROW } from "../model/row.ts"
import { DEFAULT_CONVENTIONS } from "../query/conventions.ts"
import { parseContext } from "./__fixtures__/store.ts"
import { listingPredicate } from "./predicate.ts"
import type { ListingRequest } from "./types.ts"

const OPTIONS = { conventions: DEFAULT_CONVENTIONS, scope: { nope: 1, project_id: "proj_alpha" } }
const predicate = (request: ListingRequest, defects: DefectName[] = [], entity = parseContext().entity) =>
	listingPredicate(request, OPTIONS, parseContext(defects, entity))
const scope = { asText: false, field: "project_id", kind: "cmp", nullsMatch: false, op: "eq", value: "proj_alpha" }
const hidden = { field: "deleted_at", kind: "isnull", negate: false }

describe("listingPredicate: scope and tombstones", () => {
	it("scopes by each path constraint the entity has a field for, and hides tombstones", () => {
		expect(predicate({})).toEqual({
			axes: { searched: false, selected: false, sorted: false },
			filter: null,
			scope: [scope],
			scoped: [scope],
			search: null,
			tombstones: hidden,
		})
	})

	it("shows tombstones to a filter naming the tombstone, under the leak, and where there are none", () => {
		expect(predicate({ filter: "deleted_at.is.notnull" }).tombstones).toBeNull()
		expect(predicate({ filter: "name.eq.x" }).tombstones).toEqual(hidden)
		expect(predicate({}, ["SOFT_DELETE_LEAK"]).tombstones).toBeNull()
		expect(predicate({}, [], ROW).tombstones).toBeNull()
	})

	it("drops the tenant scope once a filter is present, under the leak", () => {
		expect(predicate({ filter: "name.eq.x" }, ["TENANT_LEAK_VIA_FILTER"]).scoped).toEqual([])
		expect(predicate({}, ["TENANT_LEAK_VIA_FILTER"]).scoped).toEqual([scope])
	})
})

describe("listingPredicate: filter and search", () => {
	it("parses the filter unless it is empty or a combination drops it", () => {
		expect(predicate({ filter: "" }).filter).toBeNull()
		expect(predicate({ filter: "name.eq.x" }).filter).toMatchObject({ field: "name", value: "x" })
		expect(predicate({ filter: "name.eq.x", order: "name" }, ["FILTER_DROPPED_WHEN_SORTED"]).filter).toBeNull()
	})

	it("validates the select before the filter, and the filter before the search", () => {
		expect(() => predicate({ filter: "bogus.eq.1", select: "bogus" })).toThrow('field "bogus" is not selectable')
		expect(() => predicate({ filter: "bogus.eq.1", searchMode: "bogus" })).toThrow('field "bogus" is not filterable')
	})

	it("refuses a search mode it does not have, and prefix under the defect", () => {
		expect(() => predicate({ q: "a", searchMode: "fuzzy" })).toThrow(
			'search mode "fuzzy" is not one of contains, prefix',
		)
		expect(() => predicate({ searchMode: "prefix" }, ["SEARCH_MODE_REJECTED"])).toThrow(
			'search mode "prefix" is not supported',
		)
		expect(predicate({ q: "al", searchMode: "prefix" }).search).toMatchObject({
			children: [{ mode: "prefix", token: "al" }],
		})
	})

	it("searches unless there is no query, the search is ignored, or its axis drops it", () => {
		expect(predicate({ q: "al" }).search).toMatchObject({ children: [{ mode: "contains" }] })
		expect(predicate({ q: "al" }, ["SEARCH_IGNORED"]).search).toBeNull()
		expect(predicate({ q: "al", select: "id" }, ["SEARCH_DROPPED_WHEN_SELECTED"]).search).toBeNull()
		expect(predicate({ q: "al" }, ["SEARCH_DROPPED_WHEN_SELECTED"]).search).not.toBeNull()
		expect(predicate({ order: "name", q: "al" }, ["SEARCH_DROPPED_WHEN_SORTED"]).search).toBeNull()
		expect(predicate({ q: "al" }, ["SEARCH_DROPPED_WHEN_SORTED"]).search).not.toBeNull()
	})
})
