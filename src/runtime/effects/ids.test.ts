import { describe, expect, it } from "vitest"
import { createdIdKeys, findCreatedId, nestedParamId, scalarId } from "./ids.ts"

describe("scalarId / createdIdKeys", () => {
	it("reads a non-empty string or a finite number", () => {
		expect(scalarId("t1")).toBe("t1")
		expect(scalarId(7)).toBe("7")
		expect(scalarId("")).toBeUndefined()
		expect(scalarId(Number.NaN)).toBeUndefined()
		expect(scalarId(null)).toBeUndefined()
	})

	it("names `{entity}_id`, then the identity, then `id`, each once", () => {
		expect(createdIdKeys("table", "id")).toEqual(["table_id", "id"])
		expect(createdIdKeys("table", "table_id")).toEqual(["table_id", "id"])
		expect(createdIdKeys("table", null)).toEqual(["table_id", "id"])
		expect(createdIdKeys("table", "")).toEqual(["table_id", "id"])
		expect(createdIdKeys("table", "slug")).toEqual(["table_id", "slug", "id"])
	})
})

describe("findCreatedId", () => {
	it("reads conventional keys, nested objects, arrays, and scalars", () => {
		expect(findCreatedId({ table_id: "t1" }, ["table_id"])).toBe("t1")
		expect(findCreatedId({ id: 9 }, ["id"])).toBe("9")
		expect(findCreatedId({ data: { table: { id: "nested" } } }, ["id"])).toBe("nested")
		expect(findCreatedId({ items: [{ table_id: "from-array" }] }, ["table_id"])).toBe("from-array")
		expect(findCreatedId(null, ["id"])).toBeUndefined()
		expect(findCreatedId("x", ["id"])).toBeUndefined()
		expect(findCreatedId({ a: { b: { c: { d: { id: "too-deep" } } } } }, ["id"])).toBeUndefined()
		expect(findCreatedId([{ nope: 1 }], ["id"])).toBeUndefined()
	})
})

describe("nestedParamId", () => {
	it("reads the param itself, then the first row of an array named after its stem", () => {
		expect(nestedParamId({ columns_json: [{ id: "c1" }] }, "col_id")).toBe("c1")
		expect(nestedParamId({ col_id: "direct" }, "col_id")).toBe("direct")
		expect(nestedParamId({ name: "n" }, "slug")).toBeUndefined()
		expect(nestedParamId({ columns_json: [{}] }, "col_id")).toBeUndefined()
		expect(nestedParamId({ columns_json: [{ id: "c1" }] }, "_id")).toBeUndefined()
		expect(nestedParamId({ cols: [{ id: "c9" }] }, "col_id")).toBe("c9")
		expect(nestedParamId({ col: [{ id: "c8" }] }, "col_id")).toBe("c8")
		expect(nestedParamId({ wrap: [{ columns_json: [{ id: "c3" }] }] }, "col_id")).toBe("c3")
		expect(nestedParamId({ columns_json: [null, [], { id: "c4" }] }, "col_id")).toBe("c4")
		expect(nestedParamId({ columns: "not a list", other: [{ x: 1 }] }, "col_id")).toBeUndefined()
	})

	it("stops six levels down", () => {
		let deep: Record<string, unknown> = { columns_json: [{ id: "too-deep" }] }
		for (let i = 0; i < 8; i++) deep = { nest: deep }
		expect(nestedParamId(deep, "col_id")).toBeUndefined()
	})
})
