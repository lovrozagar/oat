import { describe, expect, it } from "vitest"
import { parseFilterGrammar } from "./filter-parse.ts"

/*
 * A grammar oat has no name for, declared as a template. The example is the one term per value
 * grammar seen in the wild: `and_Qty_eq_2`, `ne` for not-equal, null tests as their own terms,
 * `in` values joined by a comma, and terms sent as a repeated parameter.
 */
const EXAMPLE = {
	combine: "repeat",
	conj: { and: "and", or: "or" },
	list: ",",
	null: { is: "{conj}_{field}_is_null", not: "{conj}_{field}_isn_null" },
	ops: { eq: "eq", gt: "gt", gte: "gte", in: "in", like: "like", lt: "lt", lte: "lte", neq: "ne" },
	or: "terms",
	term: "{conj}_{field}_{op}_{value}",
}

describe("parseFilterGrammar", () => {
	it("reads the template form", () => {
		const result = parseFilterGrammar(EXAMPLE)
		expect(result).toEqual({
			ok: true,
			spec: {
				and: "repeat",
				conj: { and: "and", or: "or" },
				escape: {},
				likeWildcard: "%",
				list: { close: "", join: ",", open: "" },
				mixed: false,
				null: { is: "{conj}_{field}_is_null", not: "{conj}_{field}_isn_null" },
				ops: { eq: "eq", gt: "gt", gte: "gte", in: "in", like: "like", lt: "lt", lte: "lte", neq: "ne" },
				or: "terms",
				param: "filter",
				reserved: "_,",
				term: "{conj}_{field}_{op}_{value}",
			},
		})
		expect(Object.keys(result.ok ? result.spec : {})).toEqual([
			"and",
			"escape",
			"likeWildcard",
			"mixed",
			"ops",
			"or",
			"param",
			"reserved",
			"term",
			"conj",
			"list",
			"null",
		])
	})

	it("reserves every separator a value could be mistaken for", () => {
		const result = parseFilterGrammar({
			combine: { join: ";" },
			ops: { eq: "eq" },
			or: { group: "any({terms})", join: "|" },
			term: "{field}={value}",
		})
		expect(result.ok && result.spec.reserved).toBe("=;|")
		expect(result.ok && Object.keys(result.spec)).not.toContain("conj")
	})
})

describe("parseFilterGrammar: other forms", () => {
	it("reads a per-field grammar and a substring like", () => {
		const result = parseFilterGrammar({ likeMatches: "contains", ops: { eq: "eq" }, param: "{field}", term: "{value}" })
		expect(result).toEqual({
			ok: true,
			spec: {
				and: "params",
				escape: {},
				likeWildcard: null,
				mixed: false,
				ops: { eq: "eq" },
				or: "none",
				param: "field",
				reserved: "",
				term: "{value}",
			},
		})
		expect(parseFilterGrammar({ ...EXAMPLE, param: null }).ok).toBe(true)
	})
})

describe("parseFilterGrammar: errors", () => {
	it("names the key it cannot read, in order", () => {
		for (const [raw, key] of [
			["postgrest", "grammar"],
			[[], "grammar"],
			[{ ...EXAMPLE, term: "" }, "term"],
			[{ ...EXAMPLE, param: "{value}" }, "param"],
			[{ ...EXAMPLE, term: "{conj}_{field}_{op}" }, "{value}"],
			[{ ...EXAMPLE, term: "{conj}_{op}_{value}" }, "{field}"],
			[{ ...EXAMPLE, term: "{conj}_{field}_{op}_{value}{terms}" }, "{terms}"],
			[{ ...EXAMPLE, ops: { eq: "" } }, "ops.eq"],
			[{ ...EXAMPLE, ops: { approx: "~" } }, "ops.approx"],
			[{ ...EXAMPLE, combine: "sometimes" }, "combine"],
			[{ ...EXAMPLE, mixed: true }, "mixed"],
			[{ ...EXAMPLE, conj: undefined }, "conj"],
			[{ ...EXAMPLE, conj: { and: "and" } }, "or"],
			[{ ...EXAMPLE, likeMatches: "glob" }, "likeMatches"],
			[{ ...EXAMPLE, escape: { __: "~" } }, "escape"],
			[{ ...EXAMPLE, or: { group: "or({field})" } }, "or"],
			[{ ...EXAMPLE, null: "x", list: "" }, "null"],
		] as const) {
			const result = parseFilterGrammar(raw)
			expect(result.ok, key).toBe(false)
			expect(result.ok ? "" : result.error, key).toContain(key)
		}
	})
})
