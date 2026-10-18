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

/* `bindActionScope` over a raw `x-bind`, its prelude body last. */
const scopeOf = (
	pathParams: string[],
	[records, scope]: [Record<string, unknown>[], Record<string, string>],
	bind: unknown,
	beforeBody?: unknown,
) => bindActionScope({ beforeBody, bind: readActionBind(bind), pathParams, records, scope })

describe("bindActionScope", () => {
	it("walks the record for a param the scope lacks", () => {
		expect(scopeOf(["table_id", "col_id"], [[record], { table_id: "t1" }], null)).toEqual({
			col_id: "c1",
			table_id: "t1",
		})
		expect(scopeOf(["col_id"], [[{}], {}], null)).toEqual({})
		expect(scopeOf(["col_id"], [[{}, record], {}], null)).toEqual({ col_id: "c1" })
	})

	it("prefers an explicit x-bind.path, from the prelude or the record", () => {
		expect(
			scopeOf(["member_id"], [[], { member_id: "owner" }], { path: { member_id: "before:$.id" } }, { id: "mem_1" }),
		).toEqual({
			member_id: "mem_1",
		})
		expect(
			scopeOf(["member_id"], [[], { member_id: "owner" }], { path: { member_id: "before:$.missing" } }, {}),
		).toEqual({
			member_id: "owner",
		})
		expect(
			scopeOf(["template_id"], [[record], {}], { path: { template_id: "before:$.id" } }, { id: "tmpl_1" }),
		).toEqual({
			template_id: "tmpl_1",
		})
		expect(scopeOf(["col_id"], [[record], {}], { path: { col_id: "$.nope" } })).toEqual({ col_id: "c1" })
		expect(scopeOf(["template_id"], [[], {}], { path: { template_id: "before:id" } }, { id: "x" })).toEqual({})
		expect(scopeOf(["col_id"], [[record], {}], { path: { col_id: "$.columns_json[*].id" } })).toEqual({ col_id: "c1" })
		expect(scopeOf(["col_id"], [[record], {}], { path: { col_id: "$.columns_json[*].nope" } })).toEqual({
			col_id: "c1",
		})
		expect(scopeOf(["col_id"], [[], {}], { path: { col_id: "literal" } })).toEqual({ col_id: "literal" })
	})
})

describe("applyActionBind", () => {
	it("overlays the body and fills the query from literals and pointers", () => {
		const applied = applyActionBind(
			readActionBind({
				body: { order: "$.columns_json[*].id" },
				query: { aggs: "aa0.count", names: "$.columns_json[*].name" },
			}),
			[record],
			undefined,
			{ order: ["generated"] },
		)
		expect(applied.body).toEqual({ order: ["c1"] })
		expect(applied.query).toEqual({ aggs: "aa0.count", names: "aa0" })
		expect(applyActionBind(null, [], undefined, undefined)).toEqual({ body: undefined, query: {} })
		expect(applyActionBind(readActionBind({ query: { n: "$.n" } }), [{ n: 2 }], undefined, undefined).query).toEqual({
			n: "2",
		})
	})

	it("leaves out what resolves to nothing", () => {
		expect(
			applyActionBind(
				readActionBind({ body: { order: "$.id" }, query: { aggs: "$.name" } }),
				[{ id: "c1", name: "" }],
				undefined,
				undefined,
			),
		).toEqual({ body: undefined, query: {} })
		expect(
			applyActionBind(
				readActionBind({ query: { names: "$.columns_json[*].name" } }),
				[{ columns_json: [{ name: "" }, { name: "aa0" }] }],
				undefined,
				{},
			).query,
		).toEqual({ names: "aa0" })
		expect(
			applyActionBind(readActionBind({ body: { name: "$.missing" } }), [record], undefined, { name: "old" }).body,
		).toEqual({
			name: "old",
		})
		expect(
			applyActionBind(
				readActionBind({ query: { flag: "$.flag", names: "$.columns_json[*].name", n: "$.n" } }),
				[{ columns_json: [{ name: "" }], flag: true, n: Number.POSITIVE_INFINITY }],
				undefined,
				{},
			).query,
		).toEqual({})
	})
})

describe("applyActionBind on a list field", () => {
	it("keeps a list field a list", () => {
		expect(
			applyActionBind(readActionBind({ body: { ids: "$.id" } }), [{ id: "apkey_1" }], undefined, { ids: ["generated"] })
				.body,
		).toEqual({ ids: ["apkey_1"] })
		expect(
			applyActionBind(readActionBind({ body: { ids: "before:$.ids" } }), [], { ids: ["a"] }, { ids: ["b"] }).body,
		).toEqual({
			ids: ["a"],
		})
	})
})
