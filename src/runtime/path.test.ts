import { describe, expect, it } from "vitest"
import { readAll, readPath } from "./path.ts"

const body = {
	topics: [
		{ id: "t_1", name: "Product", subscribed: false },
		{ id: "t_2", name: "Engineering", subscribed: true },
		{ id: 3, name: "Numbered", subscribed: false },
	],
}

describe("readAll", () => {
	it("fans out at [*]", () => {
		expect(readAll(body, "$.topics[*].id")).toEqual(["t_1", "t_2", 3])
	})

	it("keeps only the items a [?(@.field==value)] filter names", () => {
		expect(readAll(body, "$.topics[?(@.id=='t_2')].subscribed")).toEqual([true])
		expect(readAll(body, '$.topics[?(@.id=="t_1")].name')).toEqual(["Product"])
		expect(readAll(body, "$.topics[?(@.id==3)].name")).toEqual(["Numbered"])
		expect(readAll(body, "$.topics[?(@.subscribed==true)].id")).toEqual(["t_2"])
	})

	it("names nothing when no item matches the filter", () => {
		expect(readAll(body, "$.topics[?(@.id=='t_9')].subscribed")).toEqual([])
	})
})

describe("readPath", () => {
	it("reads the first item a filter names, so saveAs can pick a row by a field", () => {
		expect(readPath(body, "$.topics[?(@.name=='Engineering')].id")).toBe("t_2")
		expect(readPath(body, "$.topics[?(@.name=='Nobody')].id")).toBeUndefined()
	})
})

describe("readPath by dotted path", () => {
	const nested = { items: [{ id: "a" }, { id: "b" }], label: "x" }

	it("reads brackets and dotted indexes as the same segment", () => {
		expect(readPath(nested, "$.items[1].id")).toBe("b")
		expect(readPath(nested, "items.0.id")).toBe("a")
		expect(readPath(nested, "$")).toBe(nested)
	})

	it("names nothing below a primitive, or by a word inside an array", () => {
		expect(readPath(nested, "$.label.length")).toBeUndefined()
		expect(readPath(nested, "$.items.first")).toBeUndefined()
		expect(readPath(null, "$.a")).toBeUndefined()
	})
})

describe("readPath by JSON pointer", () => {
	const doc = { "a/b": { "c~d": 1 }, items: [{ id: "a" }], n: 5 }

	it("reads segments, unescaping ~1 and ~0, and the root as the whole body", () => {
		expect(readPath(doc, "/items/0/id")).toBe("a")
		expect(readPath(doc, "/a~1b/c~0d")).toBe(1)
		expect(readPath(doc, "/")).toBe(doc)
	})

	it("names nothing below a primitive, or by a word inside an array", () => {
		expect(readPath(doc, "/n/x")).toBeUndefined()
		expect(readPath(doc, "/items/first")).toBeUndefined()
	})
})

describe("readAll paths", () => {
	it("names the one node a plain path reads, or none", () => {
		expect(readAll(body, "$.topics.0.name")).toEqual(["Product"])
		expect(readAll(body, "$.missing")).toEqual([])
	})

	it("fans out from the root, nests branches, and stops at what is not a list", () => {
		expect(readAll(["a", "b"], "[*]")).toEqual(["a", "b"])
		expect(readAll([["a"], ["b", "c"]], "$[*][*]")).toEqual(["a", "b", "c"])
		expect(readAll(body, "$.topics[*][?(@.id=='t_1')]")).toEqual([])
		expect(readAll({ topics: { id: 1 } }, "$.topics[*]")).toEqual([])
		expect(readAll(body, "$.topics[?(@.subscribed==false)]")).toHaveLength(2)
	})

	it("reads false, null, numbers and bare words as filter values, and skips items that are not objects", () => {
		const rows = [null, 7, { v: false }, { v: null }, { v: 2 }, { v: "on" }]
		expect(readAll(rows, "$[?(@.v==false)]")).toEqual([{ v: false }])
		expect(readAll(rows, "$[?(@.v==null)]")).toEqual([{ v: null }])
		expect(readAll(rows, "$[?(@.v== 2 )]")).toEqual([{ v: 2 }])
		expect(readAll(rows, "$[?(@.v==on)]")).toEqual([{ v: "on" }])
	})
})
