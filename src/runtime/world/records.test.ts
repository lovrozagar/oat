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

	it("reads a list's rows from a bare array or under its collection key", () => {
		expect(recordsFromList([{ id: 1 }], null)).toEqual([{ id: 1 }])
		expect(recordsFromList({ items: [{ id: 2 }] }, "items")).toEqual([{ id: 2 }])
		expect(recordsFromList({ items: "x" }, "items")).toEqual([])
		expect(recordsFromList({ items: [{ id: 2 }] }, null)).toEqual([])
		expect(recordsFromList(null, "items")).toEqual([])
	})
})
