import { describe, expect, it } from "vitest"
import { CLASSIC, JSONAPI, LINKED, PLAIN, POSTGREST, TEMPLATE } from "../dialect/presets.ts"
import type { Dialect } from "../dialect/types.ts"
import type { ListingResult } from "../listing/types.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import { equalityFilter, paginated, selectParam, staleWindow, toCanonicalOrder } from "./listing-query.ts"

const url = (search: string): URL => new URL(`http://reference.test/v1/projects/p/tables${search}`)
const result = (more: Partial<ListingResult> = {}): ListingResult => ({
	count: 3,
	hasMore: true,
	items: [{ id: "a" }, { id: "b" }],
	limit: 2,
	nextCursor: "c2",
	offset: 4,
	page: 3,
	...more,
})

describe("toCanonicalOrder", () => {
	it("answers nothing for no sort", () => {
		expect(toCanonicalOrder(undefined, POSTGREST)).toBeUndefined()
		expect(toCanonicalOrder("", POSTGREST)).toBeUndefined()
	})

	it("passes the dotted grammar through", () => {
		expect(toCanonicalOrder("name.desc,id", POSTGREST)).toBe("name.desc,id")
	})

	it("reads the prefixed grammar", () => {
		expect(toCanonicalOrder("-name, id,", JSONAPI)).toBe("name.desc,id.asc")
	})

	it("reads the colon and spaced grammars, passing an unknown direction through", () => {
		expect(toCanonicalOrder("name:DESC,id:asc,position", PLAIN)).toBe("name.desc,id.asc,position.asc")
		expect(toCanonicalOrder("name:up", PLAIN)).toBe("name:up")
		const spaced: Dialect = { ...POSTGREST, sortGrammar: "spaced" }
		expect(toCanonicalOrder("name desc,id", spaced)).toBe("name.desc,id.asc")
	})

	it("reads the template grammar, and hands an unknown direction on to be refused", () => {
		expect(toCanonicalOrder("created_at_descending,name_ascending", TEMPLATE)).toBe("created_at.desc,name.asc")
		expect(toCanonicalOrder("name_sideways", TEMPLATE)).toBe("name.sideways")
		expect(toCanonicalOrder("name", TEMPLATE)).toBe("name")
	})
})

describe("equalityFilter", () => {
	it("collects one filterable field as a term, several as a conjunction", () => {
		expect(equalityFilter(url("?status=active"), TABLE)).toBe("status.eq.active")
		expect(equalityFilter(url("?status=active&name=a&per=1"), TABLE)).toBe("and(name.eq.a,status.eq.active)")
	})

	it("answers null when no filterable field is given", () => {
		expect(equalityFilter(url("?bogus=1"), TABLE)).toBeNull()
	})
})

describe("selectParam", () => {
	it("names the resource in a bracketed grammar", () => {
		expect(selectParam(JSONAPI, ROW)).toBe("fields[row]")
		expect(selectParam(CLASSIC, ROW)).toBe("fields")
	})
})

describe("paginated", () => {
	it("publishes only the facts the envelope names", () => {
		expect(paginated({ dialect: POSTGREST, entity: TABLE, url: url("") }, result())).toEqual({
			body: { count: 3, hasMore: true, limit: 2, nextCursor: "c2", page: 3, tables: [{ id: "a" }, { id: "b" }] },
			headers: {},
		})
		const bare: Dialect = { ...POSTGREST, envelope: { collection: "data" } }
		expect(paginated({ dialect: bare, entity: JOB, url: url("") }, result()).body).toEqual({
			data: [{ id: "a" }, { id: "b" }],
		})
	})

	it("answers a root array with a next link while more pages follow", () => {
		expect(paginated({ dialect: LINKED, entity: TABLE, url: url("?limit=2&offset=4") }, result())).toEqual({
			body: [{ id: "a" }, { id: "b" }],
			headers: { link: '</v1/projects/p/tables?limit=2&offset=6>; rel="next"' },
		})
	})

	it("answers a root array with no link on the last page or without an offset", () => {
		expect(paginated({ dialect: LINKED, entity: TABLE, url: url("") }, result({ hasMore: false })).headers).toEqual({})
		const params = { ...LINKED.params }
		delete params.offset
		const unpaged: Dialect = { ...LINKED, params }
		expect(paginated({ dialect: unpaged, entity: TABLE, url: url("") }, result())).toEqual({
			body: [{ id: "a" }, { id: "b" }],
			headers: {},
		})
	})
})

describe("staleWindow", () => {
	it("defaults to the first page at the entity's page size", () => {
		expect(staleWindow(url(""), POSTGREST, TABLE)).toEqual({ limit: 20, offset: 0, page: 1 })
	})

	it("reads a page, clamped to the entity's maximum", () => {
		expect(staleWindow(url("?limit=500&page=2"), POSTGREST, TABLE)).toEqual({ limit: 100, offset: 100, page: 2 })
	})

	it("reads an offset, and the page it falls on", () => {
		expect(staleWindow(url("?limit=5&offset=10"), LINKED, TABLE)).toEqual({ limit: 5, offset: 10, page: 3 })
	})

	it("answers null for a paging value that is not a valid one", () => {
		for (const search of ["?limit=0", "?limit=", "?page=1.5", "?page=x"]) {
			expect(staleWindow(url(search), POSTGREST, TABLE)).toBeNull()
		}
		expect(staleWindow(url("?offset=-1"), LINKED, TABLE)).toBeNull()
	})
})
