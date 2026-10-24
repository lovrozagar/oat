import { describe, expect, it } from "vitest"
import { UNICODE_COHORT_STRING } from "../payloads.ts"
import { admits, stringConstraints } from "./string-constraints.ts"

/* The write guard comb 0.13 publishes on every written string: no NUL, no unpaired surrogate. */
const GUARD = "^[^\\u0000\\uD800-\\uDFFF]*$"
const PHONE = "^\\+[1-9]\\d{7,14}$"

describe("stringConstraints", () => {
	it("reads a top-level pattern and the lengths", () => {
		expect(stringConstraints({ maxLength: 64, pattern: GUARD, type: "string" })).toEqual({
			maxLength: 64,
			minLength: 0,
			patterns: [GUARD],
		})
	})

	it("reads every pattern an allOf sets, beside the field's own bounds", () => {
		expect(
			stringConstraints({ allOf: [{ pattern: PHONE }, { pattern: GUARD }], minLength: 7, type: "string" }),
		).toEqual({ maxLength: Number.POSITIVE_INFINITY, minLength: 7, patterns: [PHONE, GUARD] })
	})

	it("reads through a nullable union to its string branch", () => {
		const phone = {
			anyOf: [
				{ allOf: [{ pattern: PHONE }, { pattern: GUARD }], maxLength: 15, minLength: 7, type: "string" },
				{ type: "null" },
			],
		}
		expect(stringConstraints(phone)).toEqual({ maxLength: 15, minLength: 7, patterns: [PHONE, GUARD] })
		expect(stringConstraints({ pattern: GUARD, type: ["string", "null"] }).patterns).toEqual([GUARD])
		expect(stringConstraints({ oneOf: [{ type: "null" }, { maxLength: 5, type: "string" }] }).maxLength).toBe(5)
		/* Two branches that are not null are no nullable union: neither is folded in. */
		expect(stringConstraints({ anyOf: [{ pattern: GUARD, type: "string" }, { type: "integer" }] })).toEqual({
			maxLength: Number.POSITIVE_INFINITY,
			minLength: 0,
			patterns: [],
		})
	})

	it("keeps an enum and a format", () => {
		expect(stringConstraints({ enum: ["a"], format: "email" })).toMatchObject({ enum: ["a"], format: "email" })
	})
})

describe("admits", () => {
	const phone = stringConstraints({ allOf: [{ pattern: PHONE }, { pattern: GUARD }], minLength: 7, type: "string" })

	it("takes a value inside every bound and every pattern", () => {
		expect(admits(phone, "+3859123456")).toBe(true)
	})

	it("refuses a value one pattern or one bound refuses", () => {
		expect(admits(phone, "Oat")).toBe(false)
		expect(admits(phone, "3859123456")).toBe(false)
		expect(admits(stringConstraints({ maxLength: 10 }), "oat-concurrent-a")).toBe(false)
	})

	it("compiles the guard with the u flag, so an astral pair passes and only a lone surrogate fails", () => {
		const guarded = stringConstraints({ pattern: GUARD })
		expect(admits(guarded, UNICODE_COHORT_STRING)).toBe(true)
		expect(admits(guarded, "Quarterly Report 2")).toBe(true)
		expect(admits(guarded, "lone \uD83D surrogate")).toBe(false)
		expect(admits(guarded, "nul \u0000 byte")).toBe(false)
	})

	it("counts length in code points", () => {
		expect(admits(stringConstraints({ maxLength: 1 }), "🙂")).toBe(true)
	})

	it("admits nothing under a pattern that does not compile", () => {
		expect(admits(stringConstraints({ pattern: "(" }), "a")).toBe(false)
	})
})
