import { describe, expect, it } from "vitest"
import { absentIdentifier, filterSentinel } from "./identifiers.ts"
import { nonceNumber } from "./nonce.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("absentIdentifier", () => {
	it("makes an absent identifier of the identifier's own format", () => {
		expect(absentIdentifier({ format: "uuid", type: "string" }, "n")).toMatchObject({
			ok: true,
			value: expect.stringMatching(UUID),
		})
		const integer = absentIdentifier({ minimum: 1, type: "integer" }, "n")
		expect(integer.ok && Number.isInteger(integer.value)).toBe(true)
	})

	it("counts down from the maximum, never below the minimum, and floors a fractional bound", () => {
		const offset = nonceNumber("n") % 1000
		expect(absentIdentifier({ type: "integer" }, "n")).toEqual({ ok: true, value: 2_147_483_647 - offset })
		expect(absentIdentifier({ maximum: 10, minimum: 5, type: "integer" }, "n")).toEqual({ ok: true, value: 5 })
		expect(absentIdentifier({ maximum: 2000.5, type: "number" }, "n")).toEqual({
			ok: true,
			value: Math.floor(2000.5 - offset),
		})
		/* Not an object: any token will do. */
		expect(absentIdentifier("not a schema", "n")).toMatchObject({
			ok: true,
			value: expect.stringMatching(/^oat-absent-/),
		})
	})

	it("makes a formatted string identity in its format", () => {
		expect(absentIdentifier({ format: "email", type: "string" }, "n")).toEqual({
			ok: true,
			value: "oat-baseline-9001@example.test",
		})
	})

	it("refuses an enumerated identity: every value may name a record", () => {
		expect(absentIdentifier({ enum: ["a", "b"], type: "string" }, "n")).toMatchObject({ ok: false })
	})

	it("sends one token when it meets the length and pattern, and none otherwise", () => {
		const token = `oat-absent-${nonceNumber("n").toString(36)}`
		expect(absentIdentifier({ pattern: "^oat-", type: "string" }, "n")).toEqual({ ok: true, value: token })
		expect(absentIdentifier({ maxLength: 3, type: "string" }, "n")).toMatchObject({ ok: false })
		expect(absentIdentifier({ minLength: 200, type: "string" }, "n")).toMatchObject({ ok: false })
		expect(absentIdentifier({ pattern: "^[0-9]+$", type: "string" }, "n")).toMatchObject({ ok: false })
		expect(absentIdentifier({ pattern: "(", type: "string" }, "n")).toMatchObject({ ok: false })
	})
})

describe("filterSentinel", () => {
	it("probes a filter with a value of the field's type", () => {
		expect(filterSentinel({ type: "integer" }, "n")).toMatchObject({ ok: true, value: expect.any(Number) })
		expect(filterSentinel({ type: "string" }, "n")).toMatchObject({ ok: true, value: expect.stringContaining("n") })
	})

	it("takes the last enum value, true for a boolean, and an absent number for a number", () => {
		expect(filterSentinel({ enum: ["a", "z"] }, "n")).toEqual({ ok: true, value: "z" })
		expect(filterSentinel({ enum: [], type: "boolean" }, "n")).toEqual({ ok: true, value: true })
		expect(filterSentinel({ type: "number" }, "n")).toEqual(absentIdentifier({ type: "number" }, "n"))
		expect(filterSentinel(null, "n")).toEqual({ ok: true, value: "zzz last alphabetically 4242 n" })
	})

	it("says why when the field's own schema cannot be met", () => {
		expect(filterSentinel({ maxLength: 1, minLength: 2, type: "string" }, "n")).toEqual({
			ok: false,
			pointer: "/value",
			reason: "minLength 2 exceeds maxLength 1",
		})
	})
})
