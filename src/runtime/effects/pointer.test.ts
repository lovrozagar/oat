import { describe, expect, it } from "vitest"
import { valueAt } from "./pointer.ts"

describe("valueAt", () => {
	it("reads the first match, or every match under `*`", () => {
		expect(valueAt({ columns_json: [{ id: "c1" }, { id: "c2" }] }, "$.columns_json[*].id")).toEqual(["c1", "c2"])
		expect(valueAt({ columns_json: [{ id: "c1" }] }, "$.columns_json[0].id")).toBe("c1")
		expect(valueAt({ items: [{}, { id: "c2" }] }, "$.items[*].id")).toEqual(["c2"])
		expect(valueAt({ items: ["a", "b"] }, "$.items.*")).toEqual(["a", "b"])
	})

	it("reads nothing off a missing key, a scalar, a non-array index or a non-pointer", () => {
		expect(valueAt({ id: "nope" }, "$.missing")).toBeUndefined()
		expect(valueAt("nope", "$.id")).toBeUndefined()
		expect(valueAt({ a: "x" }, "$.a[0]")).toBeUndefined()
		expect(valueAt({ a: { 0: "c1" } }, "$.a[0]")).toBeUndefined()
		expect(valueAt({ a: "x" }, "$.a[*]")).toEqual([])
		expect(valueAt({ id: "z" }, "id")).toBeUndefined()
	})

	it("takes `$id` as `$.id` and `$` as the root", () => {
		expect(valueAt({ id: "z" }, "$id")).toBe("z")
		expect(valueAt({ id: "z" }, "$")).toEqual({ id: "z" })
	})
})
