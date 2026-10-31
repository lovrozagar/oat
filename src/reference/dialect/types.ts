import type { RawOf } from "../../config/types/raw.ts"
import type { SortGrammarSpec } from "../../spec/render/sort.ts"
/** The names, envelope and grammars one API speaks; see `presets.ts` for why there are several. */
export interface Dialect {
	name: string
	/** The dialect names its parameters on `x-query.params`, because no alias oat knows would find them. */
	declaresParams?: boolean
	/** Query parameter names, by role. */
	params: {
		filter: string
		order: string
		select: string
		search: string
		limit: string
		/** Page number, where the API counts pages. Absent when it counts rows skipped. */
		page?: string
		/** Rows to skip, where the API pages by offset rather than page number. */
		offset?: string
		cursor?: string
		/** How the search term matches, where the API lets the caller choose. */
		searchMode?: string
	}
	/**
	 * Envelope property names, by role.
	 *
	 * `null` for the whole object means the response *is* the array and pagination facts travel in
	 * a `Link` header instead — the GitHub shape. That is a different pagination model, not a
	 * different spelling of one, which is precisely why it belongs in the fixture: a tool that
	 * only ever saw facts in a body may be reading conventions rather than the contract.
	 */
	envelope: {
		/** Property holding the array. `null` means "named after the entity" — `tables`, `rows`. */
		collection: string | null
		/* Each pagination fact is optional: a correct API may publish any subset of them. */
		total?: string
		hasMore?: string
		nextCursor?: string
		page?: string
		limit?: string
	} | null
	/**
	 * How filter expressions are written.
	 *
	 * `equality` has no filter parameter at all: each filterable field is its own query parameter,
	 * and only equality is expressible. It is the most common shape in the wild and the one where
	 * oat can say the least — which makes it the real test of whether "I cannot express this" is
	 * reported honestly rather than silently skipped.
	 */
	grammar: "postgrest" | "colon" | "equality" | "template"
	/** The template a `template` grammar declares on `x-query.grammar`. */
	filterTemplate?: Record<string, unknown>
	/** How sort directions are written. Defaults to the dotted form when unset. */
	sortGrammar?: "dotted" | "prefixed" | "colon" | "spaced" | "template"
	/** The template a `template` sort grammar declares on `x-query.sortGrammar`. */
	sortTemplate?: RawOf<SortGrammarSpec>
	/** How a sparse fieldset is written. Defaults to comma-separated names. */
	selectGrammar?: "csv" | "bracketed"
}
