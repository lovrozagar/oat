import { describe, expect, it } from "vitest"
import type { OperationObject } from "../types.ts"
import { ext, strArray } from "./tag.ts"

describe("tag reads", () => {
	it("reads an extension as it stands, or undefined", () => {
		const op = { "x-cost": "high", "x-null": null } as OperationObject
		expect(ext<string>(op, "x-cost")).toBe("high")
		expect(ext(op, "x-null")).toBeNull()
		expect(ext(op, "x-missing")).toBeUndefined()
	})

	it("keeps the strings of a list", () => {
		expect(strArray(["a", 1, "b"])).toEqual(["a", "b"])
		expect(strArray("a")).toEqual([])
	})
})
