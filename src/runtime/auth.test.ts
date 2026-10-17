import { describe, expect, it } from "vitest"
import { interpolate } from "./auth.ts"

/*
 * A step that uploads a file sends its bytes as the body. Interpolation fills `{name}` in text; it
 * must hand bytes on untouched, or the upload arrives as a JSON object of numbered keys.
 */

describe("interpolate", () => {
	it("hands bytes on as they are", () => {
		const bytes = new Uint8Array([137, 80, 78, 71])
		expect(interpolate(bytes, { who: "oat" })).toBe(bytes)
		const buffer = bytes.buffer
		expect(interpolate(buffer, {})).toBe(buffer)
		const blob = new Blob([bytes], { type: "image/png" })
		expect(interpolate(blob, {})).toBe(blob)
	})

	it("still fills text inside objects", () => {
		expect(interpolate({ name: "{who}", tags: ["{who}"] }, { who: "oat" })).toEqual({ name: "oat", tags: ["oat"] })
	})
})
