import { describe, expect, it } from "vitest"
import { Unconstructible } from "./unconstructible.ts"

describe("Unconstructible", () => {
	it("carries the reason and where it applies", () => {
		const error = new Unconstructible("the enum is empty", "/kind")
		expect(error).toBeInstanceOf(Error)
		expect(error.message).toBe("the enum is empty")
		expect(error.reason).toBe("the enum is empty")
		expect(error.pointer).toBe("/kind")
	})
})
