import { describe, expect, it } from "vitest"
import { errorText } from "./errors.ts"

describe("errorText", () => {
	it("is an error's message, named when it is not a plain Error, and never its stack", () => {
		expect(errorText(new Error("boom"))).toBe("boom")
		expect(errorText(new TypeError("x is not a function"))).toBe("TypeError: x is not a function")
		expect(errorText(42)).toBe("42")
		expect(errorText(new Error("boom"))).not.toMatch(/\n\s+at /)
	})
})
