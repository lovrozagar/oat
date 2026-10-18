/**
 * Several predicates sent together: all of them (`and`), one of them (`or`), or one and any of
 * the rest (`a AND (b OR c)`). `null` wherever the grammar cannot say it.
 */

import type { FilterGrammarSpec, FilterPredicate, FilterQuery, TermGroup } from "./filter-types.ts"
import { canWriteOr, fill, renderFragment, renderTerm } from "./filter-term.ts"

/* A group holds `{terms}` and no other placeholder (a preset, or one `parseFilterGrammar` read), so it always fills. */
function grouped(group: TermGroup, fragments: readonly string[]): string {
	return fill(group.group, { terms: fragments.join(group.join) }) as string
}

function combined(how: "repeat" | { join: string } | TermGroup, fragments: string[]): string | readonly string[] {
	if (how === "repeat") return fragments
	if ("group" in how) return grouped(how, fragments)
	return fragments.join(how.join)
}

/** Every predicate as a fragment, or `null` when one cannot be written. */
function fragmentsOf(
	spec: FilterGrammarSpec,
	predicates: readonly FilterPredicate[],
	conj: "and" | "or" = "and",
): string[] | null {
	const fragments = predicates.map((predicate) => renderFragment(spec, predicate, conj))
	return fragments.some((fragment) => fragment === null) ? null : (fragments as string[])
}

/** Predicates that must all hold, as query parameters. */
export function renderAnd(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	predicates: readonly FilterPredicate[],
): FilterQuery | null {
	if (spec.and === "params") {
		/* Distinct parameters AND implicitly: the two terms are simply merged. */
		const terms = predicates.map((predicate) => renderTerm(spec, filterParam, predicate))
		if (terms.some((term) => term === null)) return null
		return Object.assign({}, ...terms) as Record<string, string>
	}
	if (filterParam === undefined) return null
	const fragments = fragmentsOf(spec, predicates)
	return fragments === null ? null : { [filterParam]: combined(spec.and, fragments) }
}

/** Predicates of which one must hold, as query parameters; `null` when the grammar has no `or`. */
export function renderOr(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	predicates: readonly FilterPredicate[],
): FilterQuery | null {
	if (!canWriteOr(spec) || filterParam === undefined) return null
	if (spec.or === "terms") {
		const fragments = fragmentsOf(spec, predicates, "or")
		/* canWriteOr holds only for param `filter`, which never combines as `params`. */
		const and = spec.and as Exclude<FilterGrammarSpec["and"], "params">
		return fragments === null ? null : { [filterParam]: combined(and, fragments) }
	}
	const fragments = fragmentsOf(spec, predicates)
	/* canWriteOr ruled out `none`, and `terms` returned above. */
	return fragments === null ? null : { [filterParam]: grouped(spec.or as TermGroup, fragments) }
}

/** `a AND (b OR c)` as one filter value; `null` unless the grammar groups both and lets them nest. */
export function renderAndOfOr(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	first: FilterPredicate,
	either: readonly FilterPredicate[],
): Record<string, string> | null {
	if (!spec.mixed || filterParam === undefined) return null
	const head = renderFragment(spec, first)
	const tail = fragmentsOf(spec, either)
	if (head === null || tail === null) return null
	/* Only a grammar that groups both `and` and `or` is mixed. */
	const inner = grouped(spec.or as TermGroup, tail)
	return { [filterParam]: grouped(spec.and as TermGroup, [head, inner]) }
}
