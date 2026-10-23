import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { ext, extObject, strArray } from "./tag.ts"

describe("tag reads", () => {
	it("reads an extension as it stands, or undefined", () => {
		const op = { "x-cost": "high", "x-null": null } as OperationObject
		expect(ext(op, "x-cost")).toBe("high")
		expect(ext(op, "x-null")).toBeNull()
		expect(ext(op, "x-missing")).toBeUndefined()
	})

	it("keeps the strings of a list", () => {
		expect(strArray(["a", 1, "b"])).toEqual(["a", "b"])
		expect(strArray("a")).toEqual([])
	})
})

/** `x-t` read as an object tag, when it holds `value`. */
const objectTag = (value: unknown) => extObject({ responses: {}, "x-t": value } as never, "x-t")

describe("extObject", () => {
	it("is a tag only when its value is an object", () => {
		expect(objectTag({ a: 1 })).toEqual({ a: 1 })
		expect([objectTag(null), objectTag("s"), objectTag([1]), objectTag(undefined)]).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		])
	})
})
