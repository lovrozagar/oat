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

describe("interpolate, with kept values", () => {
	it("replaces a field that is exactly `{name}` of a kept value, anywhere, and fills the rest from scope", () => {
		const kept = new Map<string, unknown>([
			["credential", { id: "c1" }],
			["count", 3],
			["user-rep", { id: "u1" }],
		])
		const bytes = new Uint8Array([1, 2])
		expect(
			interpolate(
				{
					bytes,
					list: ["{count}", "{other}", "x {count}"],
					nested: { value: "{credential}" },
					none: null,
					on: true,
					user: "{user-rep}",
				},
				{ count: "3" },
				kept,
			),
		).toEqual({
			bytes,
			list: [3, "{other}", "x 3"],
			nested: { value: { id: "c1" } },
			none: null,
			on: true,
			user: { id: "u1" },
		})
	})

	it("never reads text inside a kept value as a placeholder", () => {
		const event = { url: "https://pay.test/?session={CHECKOUT_SESSION_ID}&org={org}" }
		expect(interpolate("{event}", { org: "o1" }, new Map([["event", event]]))).toBe(event)
	})
})
