import { describe, expect, it } from "vitest"
import { parseFilterGrammar } from "./filter-parse.ts"
import { FILTER_PRESETS } from "./filter-presets.ts"
import { renderMalformed, renderUnknownOp } from "./filter-probe.ts"
import type { FilterGrammarSpec } from "./filter-types.ts"

function parsed(raw: unknown): FilterGrammarSpec {
	const result = parseFilterGrammar(raw)
	if (!result.ok) throw new Error(result.error)
	return result.spec
}

const conjoined = parsed({
	conj: { and: "and" },
	ops: { eq: "eq", gt: "gt" },
	term: "{conj}_{field}_{op}_{value}",
})
const postgrest: FilterGrammarSpec = FILTER_PRESETS.postgrest
const probe = (spec: FilterGrammarSpec, value = "x") => ({ field: "name", filterParam: "filter", spec, value })
const unparametered = (spec: FilterGrammarSpec) => ({ field: "name", filterParam: undefined, spec, value: "x" })

describe("an unknown operator", () => {
	it("swaps the operator token, keeping the conjunction", () => {
		expect(renderUnknownOp(probe(postgrest), "approx")).toEqual({ filter: "name.approx.x" })
		expect(renderUnknownOp(probe(conjoined), "approx")).toEqual({ filter: "and_name_approx_x" })
	})

	it("is null without an operator token, a filter parameter, or a writable value", () => {
		expect(renderUnknownOp(probe(FILTER_PRESETS.equality), "approx")).toBeNull()
		expect(renderUnknownOp(probe(parsed({ ops: { eq: "=" }, term: "{field}={value}" })), "approx")).toBeNull()
		expect(renderUnknownOp(unparametered(postgrest), "approx")).toBeNull()
		expect(renderUnknownOp(probe({ ...postgrest, reserved: "," }, "a,b"), "approx")).toBeNull()
	})
})

describe("a malformed term", () => {
	it("drops the conjunction where the term has one, with the literal after it", () => {
		expect(renderMalformed(probe(conjoined))).toEqual({ filter: "name_eq_x" })
	})

	it("drops the operator otherwise, with the literal that joined it", () => {
		expect(renderMalformed(probe(postgrest))).toEqual({ filter: "name.x" })
		expect(renderMalformed(probe(FILTER_PRESETS.colon))).toEqual({ filter: "name=x" })
		/* At the end of the term, the literal before the piece goes with it. */
		expect(renderMalformed(probe(parsed({ ops: { eq: "eq" }, term: "{field}:{value}~{op}" })))).toEqual({
			filter: "name:x",
		})
		/* At the start, nothing precedes it. */
		expect(renderMalformed(probe(parsed({ ops: { eq: "eq" }, term: "{op}:{field}={value}" })))).toEqual({
			filter: "name=x",
		})
	})

	it("writes eq as eq where the grammar has no eq token", () => {
		expect(
			renderMalformed(probe(parsed({ conj: { and: "&" }, ops: { gt: "gt" }, term: "{conj}{field}.{op}.{value}" }))),
		).toEqual({
			filter: "name.eq.x",
		})
	})

	it("is null without a piece to drop, a filter parameter, or a writable value", () => {
		expect(renderMalformed(probe(parsed({ ops: { eq: "=" }, term: "{field}={value}" })))).toBeNull()
		expect(renderMalformed(probe(FILTER_PRESETS.equality))).toBeNull()
		expect(renderMalformed(unparametered(postgrest))).toBeNull()
		expect(renderMalformed(probe({ ...postgrest, reserved: "," }, "a,b"))).toBeNull()
	})
})
