import { describe, expect, it } from "vitest"
import { uuidFrom } from "./format.ts"
import { matches, matching } from "./pattern.ts"
import type { At, Context } from "./types.ts"

const at = (fields: Partial<Context> = {}, distinct = false): At => ({
	ctx: {
		defs: {},
		depth: 0,
		distinct: new Set(),
		index: 4,
		nonce: "n0",
		optional: "all",
		rand: () => 0.5,
		refs: [],
		variant: "baseline",
		...fields,
	},
	distinct,
	pointer: "/code",
})

const ANY = { max: Number.POSITIVE_INFINITY, min: 0 }

describe("matches", () => {
	it("tests a pattern as a unicode regex, and an invalid one as no match", () => {
		expect(matches("^a+$", "aaa")).toBe(true)
		expect(matches("^a+$", "b")).toBe(false)
		expect(matches("(", "(")).toBe(false)
	})
})

describe("matching", () => {
	it("prefers the pattern's own expansion with the index after it", () => {
		expect(matching("^[A-Z]{3}[0-9]+$", ANY, at())).toBe("AAA004")
	})

	it("uses the nonce as the suffix when the value must be distinct", () => {
		expect(matching("^tag-", ANY, at({}, true))).toBe("tag-n0")
	})

	it("cuts a candidate to the maximum or pads it to the minimum", () => {
		expect(matching("^[a-z]+$", { max: 2, min: 0 }, at())).toBe("aa")
		expect(matching("^[0-9]{6}$", { max: 6, min: 6 }, at())).toBe("000000")
		expect(matching("^a{6}", { max: 9, min: 9 }, at())).toBe("aaaaaa444")
	})

	it("falls back to stock candidates when the expansion fails", () => {
		/* An unclosed class expands to nothing, and as a regex matches nothing either. */
		expect(matching("[", ANY, at())).toBeUndefined()
		expect(matching("^oat\\d?$|^zz$", ANY, at({ nonce: undefined }, true))).toBe("oat4")
		expect(matching("^(?=.*@)[a-z0-9-]+@example\\.test$", ANY, at())).toBe("oat-baseline-4@example.test")
		expect(matching("^(?=https:)", ANY, at())).toBe("https://example.test/4")
		expect(matching("^(?=.{36}$)[0-9a-f]{8}-", ANY, at())).toBe(uuidFrom("baseline:4"))
	})

	it("can answer with the empty string, and with nothing when no candidate fits", () => {
		expect(matching("^$", ANY, at())).toBe("")
		expect(matching("^$", ANY, at({ nonce: "" }, true))).toBe("")
		expect(matching("^[0-9]{3}$", { max: 2, min: 0 }, at())).toBeUndefined()
	})
})
