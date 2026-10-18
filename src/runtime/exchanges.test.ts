import { describe, expect, it } from "vitest"
import { exchangeFileStem, isBinaryMediaType, primaryMediaType, sanitizeExchangeId } from "./exchanges.ts"

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

describe("primaryMediaType", () => {
	it("is the type without its parameters, or the fallback when none is named", () => {
		expect(primaryMediaType("application/json; charset=utf-8", "x")).toBe("application/json")
		expect(primaryMediaType("charset=utf-8", "text/plain")).toBe("text/plain")
		expect(primaryMediaType("", "text/plain")).toBe("text/plain")
	})
})

describe("isBinaryMediaType", () => {
	it("knows media, archives, documents and spreadsheets", () => {
		for (const type of [
			"image/png",
			"audio/mpeg",
			"video/mp4",
			"application/octet-stream",
			"application/pdf",
			"application/zip",
			"application/vnd.ms-excel",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/vnd.oasis.opendocument.text",
			"Image/JPEG; q=1",
		]) {
			expect([type, isBinaryMediaType(type)]).toEqual([type, true])
		}
	})

	it("reads text and JSON as text", () => {
		expect(isBinaryMediaType("application/json")).toBe(false)
		expect(isBinaryMediaType("text/csv")).toBe(false)
	})
})
