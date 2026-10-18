import { describe, expect, it } from "vitest"
import { CLASSIC, LINKED, POSTGREST } from "../dialect/presets.ts"
import type { Dialect } from "../dialect/types.ts"
import { shapedDialect } from "./dialect.ts"

/* A dialect publishing no page facts at all: what each model must add of its own. */
const BARE: Dialect = {
	envelope: { collection: null },
	grammar: "postgrest",
	name: "bare",
	params: { filter: "f", limit: "l", order: "o", search: "q", select: "s" },
}

describe("shapedDialect: the dialect and page numbers", () => {
	it("serves the dialect itself when the shape changes neither paging nor sorting", () => {
		expect(shapedDialect(POSTGREST, {})).toBe(POSTGREST)
	})

	it("pages by number with a total, dropping cursor, offset and the more-pages flag", () => {
		const paged = shapedDialect(POSTGREST, { pagination: "page-total" })
		expect(paged.params).toEqual({
			filter: "filter",
			limit: "limit",
			order: "order",
			page: "page",
			search: "q",
			searchMode: "search_mode",
			select: "select",
		})
		expect(paged.envelope).toEqual({ collection: null, limit: "limit", page: "page", total: "count" })
		expect(shapedDialect(BARE, { pagination: "page-total" })).toMatchObject({
			envelope: { page: "page", total: "total" },
			params: { page: "page" },
		})
		expect(shapedDialect(LINKED, { pagination: "page-total" })).toMatchObject({
			envelope: null,
			params: { page: "page" },
		})
	})
})

describe("shapedDialect: the other paging models", () => {
	it("pages by skip and take with only a total in a data envelope", () => {
		const paged = shapedDialect(CLASSIC, { pagination: "offset-total" })
		expect(paged.params).toMatchObject({ limit: "take", offset: "skip" })
		expect(paged.params.page).toBeUndefined()
		expect(paged.envelope).toEqual({ collection: "data", total: "totalCount" })
	})

	it("pages by a forward cursor alone", () => {
		const paged = shapedDialect(CLASSIC, { pagination: "cursor-only" })
		expect(paged.params).toMatchObject({ cursor: "cursor" })
		expect(paged.params.page).toBeUndefined()
		expect(paged.envelope).toEqual({ collection: "data", limit: "per_page", nextCursor: "next_cursor" })
		expect(shapedDialect(POSTGREST, { pagination: "cursor-only" }).envelope).toMatchObject({ nextCursor: "nextCursor" })
		expect(shapedDialect(LINKED, { pagination: "cursor-only" })).toMatchObject({
			envelope: null,
			params: { cursor: "cursor" },
		})
	})

	it("spells several sort keys as the sort parameter repeated, over any paging model", () => {
		const sorted = shapedDialect(CLASSIC, { pagination: "offset-total", repeatedSort: true })
		expect(sorted).toMatchObject({ params: { limit: "take", order: "sort" }, sortGrammar: "template" })
		expect(sorted.sortTemplate).toEqual({
			asc: "ascending",
			desc: "descending",
			join: "repeat",
			term: "{field}_{direction}",
		})
	})

	it("never changes the dialect it is given", () => {
		const before = JSON.stringify(POSTGREST)
		shapedDialect(POSTGREST, { pagination: "cursor-only", repeatedSort: true })
		shapedDialect(POSTGREST, { pagination: "page-total" })
		expect(JSON.stringify(POSTGREST)).toBe(before)
	})
})
