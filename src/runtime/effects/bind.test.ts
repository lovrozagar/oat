import { describe, expect, it } from "vitest"
import { applyActionBind, bindActionScope, readActionBind, readBefore } from "./bind.ts"

const record = { columns_json: [{ id: "c1", name: "aa0" }] }

describe("readActionBind / readBefore", () => {
	it("keeps the non-empty strings of path, body and query", () => {
		expect(readActionBind(null)).toBeNull()
		expect(readActionBind([])).toBeNull()
		expect(readActionBind("x")).toBeNull()
		expect(readActionBind({ path: { col_id: "$.columns_json[0].id" }, body: { order: 1 }, query: {} })).toEqual({
			path: { col_id: "$.columns_json[0].id" },
			body: {},
			query: {},
		})
		expect(readActionBind({ body: [], path: null, query: { a: "", b: "x" } })).toEqual({
			body: {},
			path: {},
			query: { b: "x" },
		})
		expect(readBefore("")).toBeUndefined()
		expect(readBefore(3)).toBeUndefined()
		expect(readBefore("table.delete")).toBe("table.delete")
	})
})

/** The seeded instance an action runs against, and the prelude's body when there is one. */
interface Seeded {
	pathParams: string[]
	records: Record<string, unknown>[]
	scope: Record<string, string>
	beforeBody?: unknown
}

/* `bindActionScope` over a raw `x-bind`. */
const scopeOf = (bind: unknown, seeded: Seeded) =>
	bindActionScope({ ...seeded, beforeBody: seeded.beforeBody, bind: readActionBind(bind) })

describe("bindActionScope", () => {
	it("walks the record for a param the scope lacks", () => {
		expect(scopeOf(null, { pathParams: ["table_id", "col_id"], records: [record], scope: { table_id: "t1" } })).toEqual(
			{
				col_id: "c1",
				table_id: "t1",
			},
		)
		expect(scopeOf(null, { pathParams: ["col_id"], records: [{}], scope: {} })).toEqual({})
		expect(scopeOf(null, { pathParams: ["col_id"], records: [{}, record], scope: {} })).toEqual({ col_id: "c1" })
	})

	it("prefers an explicit x-bind.path, from the prelude or the record", () => {
		expect(
			scopeOf(
				{ path: { member_id: "before:$.id" } },
				{ pathParams: ["member_id"], records: [], scope: { member_id: "owner" }, beforeBody: { id: "mem_1" } },
			),
		).toEqual({
			member_id: "mem_1",
		})
		expect(
			scopeOf(
				{ path: { member_id: "before:$.missing" } },
				{ pathParams: ["member_id"], records: [], scope: { member_id: "owner" }, beforeBody: {} },
			),
		).toEqual({
			member_id: "owner",
		})
		expect(
			scopeOf(
				{ path: { template_id: "before:$.id" } },
				{ pathParams: ["template_id"], records: [record], scope: {}, beforeBody: { id: "tmpl_1" } },
			),
		).toEqual({
			template_id: "tmpl_1",
		})
		expect(scopeOf({ path: { col_id: "$.nope" } }, { pathParams: ["col_id"], records: [record], scope: {} })).toEqual({
			col_id: "c1",
		})
		expect(
			scopeOf(
				{ path: { template_id: "before:id" } },
				{ pathParams: ["template_id"], records: [], scope: {}, beforeBody: { id: "x" } },
			),
		).toEqual({})
		expect(
			scopeOf({ path: { col_id: "$.columns_json[*].id" } }, { pathParams: ["col_id"], records: [record], scope: {} }),
		).toEqual({ col_id: "c1" })
		expect(
			scopeOf({ path: { col_id: "$.columns_json[*].nope" } }, { pathParams: ["col_id"], records: [record], scope: {} }),
		).toEqual({
			col_id: "c1",
		})
		expect(scopeOf({ path: { col_id: "literal" } }, { pathParams: ["col_id"], records: [], scope: {} })).toEqual({
			col_id: "literal",
		})
	})
})

describe("applyActionBind", () => {
	it("overlays the body and fills the query from literals and pointers", () => {
		const applied = applyActionBind(
			readActionBind({
				body: { order: "$.columns_json[*].id" },
				query: { aggs: "aa0.count", names: "$.columns_json[*].name" },
			}),
			{ records: [record], beforeBody: undefined },
			{ order: ["generated"] },
		)
		expect(applied.body).toEqual({ order: ["c1"] })
		expect(applied.query).toEqual({ aggs: "aa0.count", names: "aa0" })
		expect(applyActionBind(null, { records: [], beforeBody: undefined }, undefined)).toEqual({
			body: undefined,
			query: {},
		})
		expect(
			applyActionBind(
				readActionBind({ query: { n: "$.n" } }),
				{ records: [{ n: 2 }], beforeBody: undefined },
				undefined,
			).query,
		).toEqual({
			n: "2",
		})
	})

	it("leaves out what resolves to nothing", () => {
		expect(
			applyActionBind(
				readActionBind({ body: { order: "$.id" }, query: { aggs: "$.name" } }),
				{ records: [{ id: "c1", name: "" }], beforeBody: undefined },
				undefined,
			),
		).toEqual({ body: undefined, query: {} })
		expect(
			applyActionBind(
				readActionBind({ query: { names: "$.columns_json[*].name" } }),
				{ records: [{ columns_json: [{ name: "" }, { name: "aa0" }] }], beforeBody: undefined },
				{},
			).query,
		).toEqual({ names: "aa0" })
		expect(
			applyActionBind(
				readActionBind({ body: { name: "$.missing" } }),
				{ records: [record], beforeBody: undefined },
				{ name: "old" },
			).body,
		).toEqual({
			name: "old",
		})
		expect(
			applyActionBind(
				readActionBind({ query: { flag: "$.flag", names: "$.columns_json[*].name", n: "$.n" } }),
				{ records: [{ columns_json: [{ name: "" }], flag: true, n: Number.POSITIVE_INFINITY }], beforeBody: undefined },
				{},
			).query,
		).toEqual({})
	})
})

describe("applyActionBind on a list field", () => {
	it("keeps a list field a list", () => {
		expect(
			applyActionBind(
				readActionBind({ body: { ids: "$.id" } }),
				{ records: [{ id: "apkey_1" }], beforeBody: undefined },
				{ ids: ["generated"] },
			).body,
		).toEqual({ ids: ["apkey_1"] })
		expect(
			applyActionBind(
				readActionBind({ body: { ids: "before:$.ids" } }),
				{ records: [], beforeBody: { ids: ["a"] } },
				{ ids: ["b"] },
			).body,
		).toEqual({
			ids: ["a"],
		})
	})
})
