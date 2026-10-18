import { describe, expect, it } from "vitest"
import { readJsonPathList } from "./json-path.ts"

describe("JSONPath", () => {
	it("walks $, dots, indexes, wildcards, and filters", () => {
		const body = {
			columns: [
				{ name: "id", searchable: false, type: "text" },
				{ name: "title", searchable: true, type: "text" },
			],
			ok: { columns_json: [{ name: "a" }, { name: "b" }] },
		}
		expect(readJsonPathList(undefined, "$")).toEqual([])
		expect(readJsonPathList(body, "")).toEqual([body])
		expect(readJsonPathList(body, "$.ok.columns_json[*].name")).toEqual(["a", "b"])
		expect(readJsonPathList(body, "$.ok.columns_json[0].name")).toEqual(["a"])
		expect(readJsonPathList(body, "$.columns[?(@.searchable==true)].name")).toEqual(["title"])
		expect(readJsonPathList(body, "$.columns[?(@.searchable==false)].name")).toEqual(["id"])
		expect(readJsonPathList({ rows: [{ n: null }] }, "$.rows[?(@.n==null)].n")).toEqual([null])
		expect(readJsonPathList({ rows: [{ n: "x" }] }, '$.rows[?(@.n=="x")].n')).toEqual(["x"])
		expect(readJsonPathList({ rows: [{ n: "y" }] }, "$.rows[?(@.n=='y')].n")).toEqual(["y"])
		expect(readJsonPathList({ rows: [{ n: 2 }] }, "$.rows[?(@.n==2)].n")).toEqual([2])
		expect(readJsonPathList({ rows: [{ k: "z" }] }, "$.rows[?(@.k==z)].k")).toEqual(["z"])
		expect(readJsonPathList({ rows: [1, null, { name: "a" }] }, "$.rows[*].name")).toEqual(["a"])
		expect(readJsonPathList({ rows: [null, "x", { n: 1 }] }, "$.rows[?(@.n==1)]")).toEqual([{ n: 1 }])
		expect(readJsonPathList([{ name: "a" }], "$.name")).toEqual([])
		expect(readJsonPathList({ a: 1 }, "$.missing.x")).toEqual([])
		expect(readJsonPathList({ foo: { bar: 1 } }, "$.foo[bar]")).toEqual([1])
		expect(readJsonPathList({ raw: 1 }, "$.foo[unclosed")).toEqual([])
		expect(readJsonPathList([{ name: "a" }], "$[*].name")).toEqual(["a"])
		expect(readJsonPathList({ foo: { bar: 1 } }, "$.foo[*]")).toEqual([])
	})

	it("reads a filter on a non-list as a key, and keeps a list value whole", () => {
		expect(readJsonPathList({ "?(@.n==1)": 5 }, "$[?(@.n==1)]")).toEqual([5])
		expect(readJsonPathList({ rows: [[1, 2]] }, "$.rows[0]")).toEqual([[1, 2]])
		expect(readJsonPathList({ a: { b: 1 } }, "a..b")).toEqual([1])
	})
})
