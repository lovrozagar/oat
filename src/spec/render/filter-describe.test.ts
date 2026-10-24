import { describe, expect, it } from "vitest"
import { describeFilterGrammar } from "./filter-describe.ts"
import { parseFilterGrammar } from "./filter-parse.ts"
import { FILTER_PRESETS } from "./filter-presets.ts"

describe("describeFilterGrammar", () => {
	it("says what a template writes and what it cannot", () => {
		const result = parseFilterGrammar({
			combine: { join: ";" },
			conj: { and: "and", or: "or" },
			likeMatches: "contains",
			list: ",",
			null: { is: "{field}_null", not: "{field}_notnull" },
			ops: { eq: "eq", in: "in" },
			or: "terms",
			term: "{conj}_{field}_{op}_{value}",
		})
		if (!result.ok) throw new Error(result.error)
		expect(describeFilterGrammar(result.spec)).toBe(
			'template {conj}_{field}_{op}_{value}  ops eq=eq in=in  null {field}_null / {field}_notnull  list ","  ' +
				'combine join ";"  or terms  like matches a substring  cannot write ne,neq,gt,gte,lt,lte,nin,like,ilike,contains',
		)
	})

	it("describes the presets", () => {
		expect(describeFilterGrammar(FILTER_PRESETS.postgrest)).toBe(
			"template {field}.{op}.{value}  ops eq=eq ne=ne neq=neq gt=gt gte=gte lt=lt lte=lte in=in nin=nin like=like " +
				'ilike=ilike contains=contains  null {field}.is.null / {field}.is.notnull  list ","  combine and({terms})  ' +
				"or or({terms})",
		)
		expect(describeFilterGrammar(FILTER_PRESETS.equality)).toContain("combine params  or none")
		expect(describeFilterGrammar(FILTER_PRESETS.unrecognized)).toBe(
			"template {field}{op}{value}  ops   combine repeat  or none  cannot write eq,ne,neq,gt,gte,lt,lte,in,nin,like,ilike,is,contains",
		)
	})
})
