import { describe, expect, it } from "vitest"
import { esc, unique } from "./text.ts"

describe("esc", () => {
	it("escapes what would break HTML text or a double-quoted attribute", () => {
		expect(esc(`a&b <i> "q" 'k'`)).toBe("a&amp;b &lt;i&gt; &quot;q&quot; 'k'")
	})
})

describe("unique", () => {
	it("keeps the first of each value, in order", () => {
		expect(unique(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"])
	})
})
