import { describe, expect, it } from "vitest"
import { exchangeFileStem, resolveSaveExchanges, sanitizeExchangeId } from "./files.ts"

describe("resolveSaveExchanges", () => {
	it("follows the flag, then the config, then saves on every profile but cheap", () => {
		expect(resolveSaveExchanges({ config: true, flag: false })).toBe(false)
		expect(resolveSaveExchanges({ config: false, profile: "full" })).toBe(false)
		expect(resolveSaveExchanges({ config: true, profile: "cheap" })).toBe(true)
		expect(resolveSaveExchanges({ profile: "cheap" })).toBe(false)
		expect(resolveSaveExchanges({})).toBe(true)
	})
})

describe("sanitizeExchangeId", () => {
	it("keeps a safe id, replaces runs of anything else, and trims the joins", () => {
		expect(sanitizeExchangeId(" req-1.a_b ")).toBe("req-1.a_b")
		expect(sanitizeExchangeId("/a b/../c?")).toBe("a_b_.._c")
	})

	it("names an id with nothing safe in it, and caps a long one", () => {
		expect(sanitizeExchangeId("///")).toBe("id")
		expect(sanitizeExchangeId("x".repeat(300))).toHaveLength(180)
	})
})

describe("exchangeFileStem", () => {
	it("is the request id, or the sequence when there is none", () => {
		expect(exchangeFileStem("req-1", 3, new Set())).toBe("req-1")
		expect(exchangeFileStem("  ", 3, new Set())).toBe("seq-3")
	})

	it("adds the sequence, then a counter, until the name is free", () => {
		expect(exchangeFileStem("r", 3, new Set(["r"]))).toBe("r-3")
		expect(exchangeFileStem("r", 3, new Set(["r", "r-3"]))).toBe("r-3-2")
		expect(exchangeFileStem("r", 3, new Set(["r", "r-3", "r-3-2"]))).toBe("r-3-3")
	})
})
