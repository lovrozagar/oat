import { describe, expect, it } from "vitest"
import { errorText } from "./errors.ts"

describe("errorText", () => {
	it("is an error's stack, its message without one, and anything else as text", () => {
		const stacked = new Error("boom")
		const bare = Object.assign(new Error("bare"), { stack: undefined })
		expect(errorText(stacked)).toContain("Error: boom")
		expect(errorText(bare)).toBe("bare")
		expect(errorText(42)).toBe("42")
	})
})
