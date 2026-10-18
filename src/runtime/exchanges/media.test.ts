import { describe, expect, it } from "vitest"
import { INLINE_BODY_LIMIT, isBinaryMediaType, primaryMediaType } from "./media.ts"

describe("INLINE_BODY_LIMIT", () => {
	it("keeps a body up to 256 KiB inline", () => {
		expect(INLINE_BODY_LIMIT).toBe(262_144)
	})
})

describe("primaryMediaType", () => {
	it("is the type without its parameters, or the fallback when none is named", () => {
		expect(primaryMediaType("application/json; charset=utf-8", "x")).toBe("application/json")
		expect(primaryMediaType("charset=utf-8; text/csv", "x")).toBe("text/csv")
		expect(primaryMediaType("charset=utf-8", "text/plain")).toBe("text/plain")
		expect(primaryMediaType("", "text/plain")).toBe("text/plain")
	})
})

describe("isBinaryMediaType", () => {
	it("knows media, archives, documents and spreadsheets", () => {
		const binary = [
			"image/png",
			"audio/mpeg",
			"video/mp4",
			"application/octet-stream",
			"application/pdf",
			"application/zip",
			"application/vnd.ms-excel",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"application/vnd.oasis.opendocument.text",
			"application/x-spreadsheet",
			"application/vnd.ms-officedocument",
			"Image/JPEG; q=1",
		]
		expect(binary.filter((type) => !isBinaryMediaType(type))).toEqual([])
	})

	it("reads text and JSON as text", () => {
		expect(["application/json", "text/csv", "", "text/event-stream"].some(isBinaryMediaType)).toBe(false)
	})
})
