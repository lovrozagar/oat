import { describe, expect, it } from "vitest"
import {
	catalogProblems,
	codePointCount,
	payloadFits,
	REQUIRED_IDS,
	sliceCodePoints,
	STRING_PAYLOADS,
	type StringPayload,
} from "./payloads.ts"

describe("code points", () => {
	it("counts and slices by code point, never splitting a pair", () => {
		expect(codePointCount("a🙂b")).toBe(3)
		expect(sliceCodePoints("a🙂b", 2)).toBe("a🙂")
		expect(sliceCodePoints("ab", 5)).toBe("ab")
	})

	it("fits a payload between optional bounds", () => {
		expect(payloadFits("🙂🙂", 2, 2)).toBe(true)
		expect(payloadFits("🙂🙂", 1, undefined)).toBe(false)
		expect(payloadFits("🙂", undefined, 2)).toBe(false)
		expect(payloadFits("", undefined, undefined)).toBe(true)
	})
})

describe("catalogProblems", () => {
	it("finds nothing wrong with the shipped catalog", () => {
		expect(catalogProblems()).toEqual([])
	})

	it("names every broken invariant", () => {
		const required: StringPayload[] = REQUIRED_IDS.filter((id) => id !== "nbsp").map((id) => ({
			id,
			value: "x",
			why: "",
		}))
		const broken: StringPayload[] = [
			...required,
			{ id: "empty", value: "", why: "again" },
			{ id: "nul", value: "a\u0000", why: "" },
			{ id: "long", value: "é".repeat(129), why: "" },
			{ id: "high", value: "a\uD83D", why: "" },
			{ id: "low", value: "\uDE42a", why: "" },
			{ id: "pair", value: "🙂", why: "" },
		]
		expect(catalogProblems(broken, "äöüß")).toEqual([
			"duplicate id empty",
			"nul contains NUL",
			"long exceeds 128 code points",
			"high contains a lone surrogate",
			"low contains a lone surrogate",
			"missing required family nbsp",
			"cohort missing Croatian",
			"cohort missing Russian",
			"cohort missing Japanese",
			"cohort missing emoji",
		])
	})

	it("keeps every id unique", () => {
		expect(new Set(STRING_PAYLOADS.map((payload) => payload.id)).size).toBe(STRING_PAYLOADS.length)
	})
})
