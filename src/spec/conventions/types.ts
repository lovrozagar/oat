/**
 * What a list endpoint's query parameters and response envelope *mean*, derived from the
 * document rather than assumed.
 *
 * Checks used to match on literal names — `"filter"`, `"page"`, `envelope.hasMore` — which made
 * roughly half of them fire only against APIs that happened to share the fixture's spelling.
 * Everywhere else they were skipped, and skipped silently, so a quiet run on an unfamiliar API
 * read exactly like a clean one.
 *
 * Names are matched against the aliases real APIs actually use, and the shape of the declared
 * schema breaks ties. Anything still ambiguous is left `undefined` — the check then reports that
 * it did not apply, and `x-query` can state the answer outright.
 */

import type { FilterGrammarSpec } from "../render/filter-types.ts"
import type { SortGrammarSpec } from "../render/sort.ts"

/** How filter values are spelled. Determines what oat can express, not merely what it sends. */
export type FilterGrammar =
	/** `field.op.value`, with `and(...)`/`or(...)` — PostgREST and friends. */
	| "postgrest"
	/** `field=op:value`, e.g. `?price=gt:10`. */
	| "colon"
	/** One parameter per field, equality only — `?status=active`. */
	| "equality"
	/** Declared as a template; `QueryConventions.filterGrammar` says how terms are spelled. */
	| "template"
	/** A filter expression oat could not recognise and nobody declared: no term can be written. */
	| "unrecognised"

/**
 * How a sort direction is spelled.
 *
 * The role of the parameter and the *grammar* of its value are separate problems, and generalising
 * only the first is a half-measure: an API that names the parameter `sort` but expects `-name`
 * receives `name.asc`, ignores or rejects it, and reads as a backend with broken sorting rather
 * than one speaking a dialect oat cannot write.
 */
export type SortGrammar =
	/** `field.asc` / `field.desc`, comma-separated — PostgREST. */
	| "dotted"
	/** `-field` for descending, bare for ascending — JSON:API. */
	| "prefixed"
	/** `field:asc` / `field:desc`. */
	| "colon"
	/** `field asc` / `field desc`, as SQL writes it. */
	| "spaced"
	/** Declared as a template; `QueryConventions.sortSpec` says how keys are spelled. */
	| "template"

/** How a sparse fieldset is spelled. */
export type SelectGrammar =
	/** `id,name` — comma-separated field names. */
	| "csv"
	/** `fields[type]=id,name` — JSON:API's per-type bracket form. */
	| "bracketed"

export interface QueryConventions {
	/** Parameter carrying a filter expression, when the endpoint has one. */
	filter?: string
	/** Parameter selecting sort order. */
	order?: string
	/** Parameter selecting a sparse fieldset. */
	select?: string
	/** Free-text search parameter. */
	search?: string
	/** Optional search-mode parameter (`keyword` / `semantic` / …). */
	searchMode?: string
	/** Page-size parameter. */
	limit?: string
	/** 1-based page number. */
	page?: string
	/** Zero-based row offset, where the API pages by offset rather than page number. */
	offset?: string
	/** Opaque forward cursor. */
	cursor?: string
	grammar: FilterGrammar
	/** How terms are spelled under a declared template; the named grammars are presets. */
	filterGrammar?: FilterGrammarSpec
	/**
	 * The filter grammar was declared (on `x-query` or in config), not inferred. Only then is a
	 * deliberately malformed request oat writes malformed on purpose rather than by a wrong guess.
	 */
	grammarDeclared?: true
	/** How sort directions are written for the `order` parameter. */
	sortGrammar: SortGrammar
	/** How sort keys are spelled under a declared template; the named grammars are presets. */
	sortSpec?: SortGrammarSpec
	/** The sort grammar was declared, not inferred. */
	sortDeclared?: true
	/** How a sparse fieldset is written for the `select` parameter. */
	selectGrammar: SelectGrammar
	/**
	 * Response header carrying RFC 8288 pagination links, when the document declares one.
	 *
	 * Its presence changes how "are there more pages" is answered: under Link pagination the
	 * *absence* of `rel="next"` means no, so a response with no header at all is a definite
	 * "false" rather than an unknown. Without knowing the API publishes such a header, the two
	 * are indistinguishable and the check that asks has to stand down.
	 */
	linkHeader?: string
	/** Where each is spelled in the response envelope, when the schema declares one. */
	envelope: {
		total?: string
		hasMore?: string
		nextCursor?: string
		page?: string
		limit?: string
	}
}
