import { describe, expect, it } from "vitest"
import { messageOf } from "./message.ts"

describe("messageOf", () => {
	it("is an error's message, and anything else as text", () => {
		expect(messageOf(new Error("boom"))).toBe("boom")
		expect(messageOf("plain")).toBe("plain")
	})
})
