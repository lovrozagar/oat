import { describe, expect, it } from "vitest"
import { renderParserSuite } from "./render.ts"

describe("renderParserSuite", () => {
	it("counts failures and states why each one matters", () => {
		const { failures, text } = renderParserSuite([
			{ detail: "3 ops, 1 entities", name: "plain", ok: true, why: "never shown" },
			{ detail: "threw: boom", name: "hostile", ok: false, why: "oat must not throw" },
		])
		expect(failures).toBe(1)
		expect(text).toContain(`✓ ${"plain".padEnd(28)} 3 ops, 1 entities`)
		expect(text).toContain(`✗ ${"hostile".padEnd(28)} threw: boom\n      oat must not throw`)
		expect(text).not.toContain("never shown")
		expect(text).toContain("1/2 hostile specs handled")
	})
})
