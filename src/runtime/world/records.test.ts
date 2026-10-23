import { describe, expect, it } from "vitest"
import { idOf, isPlainRecord, isScalarId, recordOf, recordsFromList } from "./records.ts"

describe("reading records", () => {
	it("knows a scalar id and a plain record", () => {
		expect([isScalarId("a"), isScalarId(1), isScalarId(true), isScalarId(null)]).toEqual([true, true, false, false])
		expect([isPlainRecord({}), isPlainRecord([]), isPlainRecord(null), isPlainRecord("x")]).toEqual([
			true,
			false,
			false,
			false,
		])
	})

	it("finds the record at the declared path, or the body itself", () => {
		expect(recordOf({ recordPath: null }, { id: 1 })).toEqual({ id: 1 })
		expect(recordOf({ recordPath: "$.data" }, { data: { id: 2 } })).toEqual({ id: 2 })
		expect(recordOf({ recordPath: "$.data" }, { success: true })).toBeUndefined()
		expect(recordOf({ recordPath: null }, [{ id: 1 }])).toBeUndefined()
	})

	it("reads an identity only when the record has one", () => {
		expect(idOf({ id: 7 }, "id")).toBe("7")
		expect(idOf({ name: "x" }, "id")).toBeUndefined()
		expect(idOf({ id: { nested: 1 } }, "id")).toBeUndefined()
		expect(idOf(undefined, "id")).toBeUndefined()
	})

	/* A missing identity used to become the text "undefined" in a path, a filter or a tenant probe. */
	it("reads a scalar identity as text, and anything else as missing", () => {
		expect(idOf({ ID: 7 }, "ID")).toBe("7")
		expect(idOf({ ID: "a-1" }, "ID")).toBe("a-1")
		expect(idOf({ id: 7 }, "ID")).toBeUndefined()
		expect(idOf({ ID: null }, "ID")).toBeUndefined()
		expect(idOf({ ID: { nested: 1 } }, "ID")).toBeUndefined()
		expect(idOf(undefined, "ID")).toBeUndefined()
	})
})

describe("recordsFromList", () => {
	it("reads a list's rows from a bare array or under its collection key", () => {
		const items = { key: "items", within: [] }
		expect(recordsFromList([{ id: 1 }], null)).toEqual([{ id: 1 }])
		expect(recordsFromList({ items: [{ id: 2 }] }, items)).toEqual([{ id: 2 }])
		expect(recordsFromList([{ id: 1 }], { key: null, within: [] })).toEqual([{ id: 1 }])
	})

	it("reads each row's record inside it when the rows wrap their record", () => {
		const hits = { key: "hits", within: ["document"] }
		const body = { hits: [{ document: { id: "a" }, highlights: [] }, { document: { id: "b" } }], found: 2 }
		expect(recordsFromList(body, hits)).toEqual([{ id: "a" }, { id: "b" }])
		expect(recordsFromList([{ a: { b: { id: 3 } } }], { key: null, within: ["a", "b"] })).toEqual([{ id: 3 }])
	})

	it("keeps only the rows that hold a record", () => {
		expect(recordsFromList([null, { id: "1" }, 7, [{ id: "2" }], "x"], null)).toEqual([{ id: "1" }])
		const hits = { key: "hits", within: ["document"] }
		const body = { hits: [{ document: null }, { other: 1 }, 7, { document: [1] }, { document: { id: "a" } }] }
		expect(recordsFromList(body, hits)).toEqual([{ id: "a" }])
	})

	it("finds nothing in anything else", () => {
		const items = { key: "items", within: [] }
		expect(recordsFromList({ items: "x" }, items)).toEqual([])
		expect(recordsFromList({ items: [{ id: 2 }] }, null)).toEqual([])
		expect(recordsFromList(null, items)).toEqual([])
		expect(recordsFromList("text", items)).toEqual([])
	})
})
