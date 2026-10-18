/** A filter grammar in one line, for `plan` and `doctor`. */

import { FILTER_OPS } from "../query/ops.ts"
import type { FilterGrammarSpec } from "./filter-types.ts"
import { canWriteOp } from "./filter-term.ts"

function describeAnd(and: FilterGrammarSpec["and"]): string {
	if (typeof and === "string") return and
	return "group" in and ? and.group : `join "${and.join}"`
}

/** A declared template in one line, for `plan` and `doctor`: what oat will write, and what it cannot. */
export function describeFilterGrammar(spec: FilterGrammarSpec): string {
	const ops = Object.entries(spec.ops)
		.map(([op, token]) => `${op}=${token}`)
		.join(" ")
	const or = typeof spec.or === "string" ? spec.or : spec.or.group
	const unwritable = FILTER_OPS.filter((op) => !canWriteOp(spec, op))
	return [
		`template ${spec.term}`,
		`ops ${ops}`,
		spec.null === undefined ? "" : `null ${spec.null.is} / ${spec.null.not}`,
		spec.list === undefined ? "" : `list "${spec.list.join}"`,
		`combine ${describeAnd(spec.and)}`,
		`or ${or}`,
		spec.likeWildcard === null ? "like matches a substring" : "",
		unwritable.length === 0 ? "" : `cannot write ${unwritable.join(",")}`,
	]
		.filter(Boolean)
		.join("  ")
}
