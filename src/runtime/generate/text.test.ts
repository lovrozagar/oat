import { describe, expect, it } from "vitest"
import type { Context } from "./types.ts"
import { slug, text } from "./text.ts"

const ctx = (fields: Partial<Context> = {}): Context => ({
	defs: {},
	depth: 0,
	distinct: new Set(),
	index: 3,
	nonce: "n0",
	optional: "all",
	rand: () => 0.5,
	refs: [],
	variant: "baseline",
	...fields,
})

describe("text", () => {
	it("is the variant's words and the index, with the nonce only when distinct", () => {
		expect(text(ctx(), false)).toBe("Quarterly Report 3")
		expect(text(ctx(), true)).toBe("Quarterly Report 3 n0")
		expect(text(ctx({ nonce: undefined }), true)).toBe("Quarterly Report 3")
		expect(text(ctx({ variant: "metacharacter" }), false)).toBe("100% _off_ *everything* 3")
	})

	it("names a variant as a lower-case token", () => {
		expect(slug("lexical-first")).toBe("lexical-first")
		expect(slug("null-heavy")).toBe("null-heavy")
	})
})
