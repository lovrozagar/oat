import { describe, expect, it } from "vitest"
import {
	isQueryParamRole,
	mergeQueryParams,
	publicRole,
	QUERY_PARAM_ROLES,
	readQueryParams,
	toNamedRoles,
} from "./query-params.ts"

describe("readQueryParams", () => {
	it("keeps every known role named by a non-empty string", () => {
		const all = {
			cursor: "c",
			filter: "filter_by",
			limit: "take",
			offset: "o",
			page: "leaf",
			search: "needle",
			searchMode: "m",
			select: "pick",
			sort: "arrange",
		}
		expect(readQueryParams(all)).toEqual(all)
	})

	it("drops unknown roles, empty names and names that are not strings", () => {
		expect(readQueryParams({ filter: "filter_by", filtre: "x", order: "o", search: "", sort: 3 })).toEqual({
			filter: "filter_by",
		})
	})

	it("reads nothing from a value that is not an object", () => {
		expect(readQueryParams(undefined)).toBeUndefined()
		expect(readQueryParams("filter_by")).toBeUndefined()
		expect(readQueryParams(["filter_by"])).toBeUndefined()
		expect(readQueryParams(null)).toBeUndefined()
	})
})

describe("toNamedRoles", () => {
	it("maps the public sort role to the order role and passes the rest through", () => {
		expect(toNamedRoles({ filter: "filter_by", limit: "take", sort: "arrange" })).toEqual({
			filter: "filter_by",
			limit: "take",
			order: "arrange",
		})
		expect(toNamedRoles({})).toEqual({})
	})
})

describe("QUERY_PARAM_ROLES", () => {
	it("lists the nine public roles, sort and not order among them", () => {
		expect(QUERY_PARAM_ROLES.toSorted()).toEqual([
			"cursor",
			"filter",
			"limit",
			"offset",
			"page",
			"search",
			"searchMode",
			"select",
			"sort",
		])
		expect(isQueryParamRole("sort")).toBe(true)
		expect(isQueryParamRole("order")).toBe(false)
	})
})

describe("mergeQueryParams", () => {
	it("lays the config's names over the tag's where the operation declares them", () => {
		const declared = ["filter_by", "q", "sort_by"]
		expect(
			mergeQueryParams({
				config: { filter: "filter_by", search: "elsewhere" },
				declared,
				tag: { filter: "nope", search: "q", sort: "sort_by" },
			}),
		).toEqual({ filter: "filter_by", search: "q", sort: "sort_by" })
		expect(mergeQueryParams({ declared, tag: "x" })).toEqual({})
	})
})

describe("publicRole", () => {
	it("says sort for the order role and keeps every other name", () => {
		expect(publicRole("order")).toBe("sort")
		expect(publicRole("filter")).toBe("filter")
	})
})
