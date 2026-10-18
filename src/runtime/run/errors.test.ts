import { describe, expect, it } from "vitest"
import { errorText, messageOf } from "./errors.ts"

describe("errorText", () => {
	it("is an error's stack, its message without one, and anything else as text", () => {
		const stacked = new Error("boom")
		const bare = Object.assign(new Error("bare"), { stack: undefined })
		expect(errorText(stacked)).toContain("Error: boom")
		expect(errorText(bare)).toBe("bare")
		expect(errorText(42)).toBe("42")
	})
})

describe("messageOf", () => {
	it("is an error's message, and anything else as text", () => {
		expect(messageOf(new Error("boom"))).toBe("boom")
		expect(messageOf("plain")).toBe("plain")
	})
})
