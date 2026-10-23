import { describe, expect, it } from "vitest"
import { interpolate } from "./interpolate.ts"

describe("interpolate", () => {
	it("fills known names in text and keeps unknown ones as written", () => {
		expect(interpolate("{who}/{what}", { who: "oat" })).toBe("oat/{what}")
	})

	it("fills a name that holds a hyphen, as path parameters and saveAs names often do", () => {
		expect(interpolate({ id: "{user-id}", path: "/users/{user-id}" }, { "user-id": "u1" })).toEqual({
			id: "u1",
			path: "/users/u1",
		})
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
