import { describe, expect, it } from "vitest"
import { jwtOf } from "./__fixtures__/jwt.ts"
import { expiresAtOf } from "./expiry.ts"

const NOW = 1_000_000

describe("expiresAtOf", () => {
	it("takes seconds as a number first", () => {
		expect(expiresAtOf({ body: {}, expiresIn: 60, now: NOW, value: jwtOf({ exp: 5 }) })).toBe(NOW + 60_000)
	})

	it("reads seconds from the issuing answer, as a number or a numeric string", () => {
		const read = (expires: unknown): number | null =>
			expiresAtOf({ body: { expires }, expiresIn: { from: "$.expires" }, now: NOW, value: "opaque" })
		expect([read(30), read("45")]).toEqual([NOW + 30_000, NOW + 45_000])
	})

	it("falls back to the JWT's exp when the answer has no usable lifetime", () => {
		const value = jwtOf({ exp: 2000 })
		expect(expiresAtOf({ body: { expires: "soon" }, expiresIn: { from: "$.expires" }, now: NOW, value })).toBe(
			2_000_000,
		)
		expect(expiresAtOf({ body: undefined, now: NOW, value })).toBe(2_000_000)
	})

	it("is null with no lifetime anywhere", () => {
		expect([
			expiresAtOf({ body: {}, now: NOW, value: "opaque" }),
			expiresAtOf({ body: {}, now: NOW, value: jwtOf({ sub: "u" }) }),
		]).toEqual([null, null])
	})
})
