import { andTerm, canWriteFilterOp, filterFragment, filterTerm, orTerm } from "../../src/spec/conventions/filter.ts"
import type { FilterGrammar, QueryConventions, SelectGrammar, SortGrammar } from "../../src/spec/conventions/types.ts"
import type { FilterTermValue } from "../../src/spec/render/filter-types.ts"
import { selectTerm } from "../../src/spec/conventions/select.ts"
import { sortTerm, sortTermWithNulls } from "../../src/spec/conventions/sort.ts"
import { FILTER_OPS } from "../../src/spec/query/ops.ts"

/*
 * Every filter, sort and select term oat can write, rendered by today's writers. The
 * characterization test compares this table with a committed copy, so a renderer change that
 * alters a single byte of a request fails it.
 */

const FILTER_GRAMMARS: readonly FilterGrammar[] = ["postgrest", "colon", "equality"]
const SORT_GRAMMARS: readonly SortGrammar[] = ["dotted", "prefixed", "colon", "spaced"]
const SELECT_GRAMMARS: readonly SelectGrammar[] = ["csv", "bracketed"]

const VALUES: readonly (readonly [string, FilterTermValue])[] = [
	["string", "alpha"],
	["comma", "a,b"],
	["dot", "a.b"],
	["paren", "a(b"],
	["integer", 5],
	["decimal", 2.5],
	["true", true],
	["false", false],
	["null", null],
	["null-word", "null"],
	["notnull", "notnull"],
	["not.null", "not.null"],
	["empty-list", []],
	["list", ["a", "b"]],
	["mixed-list", [1, null, true]],
]

function conventions(
	grammar: FilterGrammar,
	filter: string | undefined,
	sortGrammar: SortGrammar = "dotted",
	selectGrammar: SelectGrammar = "csv",
	select?: string,
): QueryConventions {
	return {
		envelope: {},
		grammar,
		selectGrammar,
		sortGrammar,
		...(filter === undefined ? {} : { filter }),
		...(select === undefined ? {} : { select }),
	}
}

export function grammarTable(): Record<string, unknown> {
	const table: Record<string, unknown> = {}
	for (const grammar of FILTER_GRAMMARS) {
		for (const filter of ["filter", undefined]) {
			const at = conventions(grammar, filter)
			const scope = `${grammar}|${filter ?? "no-filter-param"}`
			for (const op of FILTER_OPS) {
				table[`canWrite|${scope}|${op}`] = canWriteFilterOp(at, op)
				for (const [label, value] of VALUES) {
					table[`filterTerm|${scope}|${op}|${label}`] = filterTerm(at, "qty", op, value)
				}
			}
			for (const [label, value] of VALUES) {
				if (typeof value === "object" && value !== null) continue
				table[`filterFragment|${scope}|${label}`] = filterFragment(at, "qty", String(value))
			}
			table[`andTerm|${scope}`] = andTerm(at, { field: "qty", value: "2" }, { field: "name", value: "x" })
			table[`andTerm|${scope}|same-field`] = andTerm(at, { field: "qty", value: "2" }, { field: "qty", value: "3" })
			table[`orTerm|${scope}`] = orTerm(at, { field: "qty", value: "2" }, { field: "name", value: "x" })
		}
	}
	for (const grammar of SORT_GRAMMARS) {
		const at = conventions("postgrest", "filter", grammar)
		for (const direction of ["asc", "desc"] as const) {
			table[`sortTerm|${grammar}|${direction}`] = sortTerm(at, "qty", direction)
			for (const nulls of ["first", "last"] as const) {
				table[`sortTerm|${grammar}|${direction}|${nulls}`] = sortTerm(at, "qty", direction, nulls)
				table[`sortTermWithNulls|${grammar}|${direction}|${nulls}`] = sortTermWithNulls(at, "qty", direction, nulls)
			}
		}
	}
	for (const grammar of SELECT_GRAMMARS) {
		for (const select of ["select", "fields", "fields[articles]", undefined]) {
			const at = conventions("postgrest", "filter", "dotted", grammar, select)
			table[`selectTerm|${grammar}|${select ?? "no-select-param"}`] = selectTerm(at, ["id", "name"], "articles")
		}
	}
	return table
}
