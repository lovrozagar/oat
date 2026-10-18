import { describe, expect, it } from "vitest"
import { interpolate, isBytes } from "./interpolate.ts"

describe("isBytes", () => {
	it("knows a buffer, a typed view and a blob, and nothing else", () => {
		expect(isBytes(new ArrayBuffer(2))).toBe(true)
		expect(isBytes(new Uint8Array([1]))).toBe(true)
		expect(isBytes(new Blob(["x"]))).toBe(true)
		expect(isBytes("x")).toBe(false)
		expect(isBytes({ length: 1 })).toBe(false)
	})
})

describe("interpolate", () => {
	it("fills known names in text and keeps unknown ones as written", () => {
		expect(interpolate("{who}/{what}", { who: "oat" })).toBe("oat/{what}")
	})

	it("walks arrays and objects, and hands bytes and other values on as they are", () => {
		const bytes = new Uint8Array([137, 80])
		expect(interpolate({ list: ["{a}", 1], nested: { b: "{a}" }, none: null, raw: bytes }, { a: "x" })).toEqual({
			list: ["x", 1],
			nested: { b: "x" },
			none: null,
			raw: bytes,
		})
		expect(interpolate(bytes, {})).toBe(bytes)
		expect(interpolate(7, {})).toBe(7)
	})
})
