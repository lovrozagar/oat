/** Sort keys, written in whichever grammar the endpoint speaks. */

import {
	renderSortKey,
	renderSortKeys,
	SORT_PRESETS,
	type SortGrammarSpec,
	type SortKey,
	type SortValue,
} from "../render/sort.ts"
import type { QueryConventions } from "./types.ts"

/** How this endpoint's sort keys are spelled: its declared template, or its named grammar's preset. */
export function sortSpec(conventions: QueryConventions): SortGrammarSpec {
	if (conventions.sortGrammar === "template") {
		if (conventions.sortSpec === undefined) throw new Error("a template sort grammar without its template")
		return conventions.sortSpec
	}
	return SORT_PRESETS[conventions.sortGrammar]
}

/** Renders a sort term in whichever grammar the endpoint speaks. */
export function sortTerm(conventions: QueryConventions, key: SortKey): string {
	return renderSortKey(sortSpec(conventions), key)
}

/** `null` when the grammar cannot write a nulls token. */
export function sortTermWithNulls(
	conventions: QueryConventions,
	key: SortKey & { nulls: "first" | "last" },
): string | null {
	const spec = sortSpec(conventions)
	return spec.nulls === undefined ? null : renderSortKey(spec, key)
}

/** Several sort keys as one order value (a list, for a repeated grammar); `null` when it sorts by one key only. */
export function sortKeys(
	conventions: QueryConventions,
	keys: readonly (readonly [string, "asc" | "desc"])[],
): SortValue | null {
	return renderSortKeys(sortSpec(conventions), keys)
}
