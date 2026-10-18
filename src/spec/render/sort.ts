/**
 * One renderer for every sort grammar.
 *
 * The four grammars oat infers — dotted, prefixed, colon, spaced — are presets of the description
 * a document or config can declare as a template. Anything a grammar cannot write renders as
 * `null`, and the check that wanted it stands down.
 */

export interface SortGrammarSpec {
	/** One key, with `{field}` and `{direction}` placeholders. */
	term: string
	/** The direction tokens. Ascending may be empty: JSON:API writes it as the bare field. */
	asc: string
	desc: string
	/**
	 * What separates several keys; `null` when the grammar sorts by one key only; `"repeat"` when
	 * each key is the sort parameter again (`?sort=A_descending&sort=B_ascending`).
	 */
	join: string | null
	/** Appended to a key to place nulls, when the grammar has such a token. */
	nulls?: { first: string; last: string }
}

export const SORT_PRESETS = {
	colon: { asc: "asc", desc: "desc", join: ",", term: "{field}:{direction}" },
	dotted: {
		asc: "asc",
		desc: "desc",
		join: ",",
		nulls: { first: ".nullsfirst", last: ".nullslast" },
		term: "{field}.{direction}",
	},
	prefixed: { asc: "", desc: "-", join: ",", term: "{direction}{field}" },
	spaced: { asc: "asc", desc: "desc", join: ",", term: "{field} {direction}" },
} as const satisfies Record<string, SortGrammarSpec>

export type SortDirection = "asc" | "desc"

/** One key. `nulls` is appended only by a grammar that has a token for it. */
export function renderSortKey(
	spec: SortGrammarSpec,
	field: string,
	direction: SortDirection,
	nulls?: "first" | "last",
): string {
	const key = spec.term.replace(/\{(field|direction)\}/g, (_whole, name: string) =>
		name === "field" ? field : spec[direction],
	)
	return nulls === undefined || spec.nulls === undefined ? key : `${key}${spec.nulls[nulls]}`
}

/** `join` for keys sent as the sort parameter repeated, one key each, in order. */
export const REPEATED_KEYS = "repeat"

/** A sort value: one parameter value, or — for a repeated grammar — one per key, in order. */
export type SortValue = string | readonly string[]

/** Several keys in order; `null` when the grammar sorts by one key only. */
export function renderSortKeys(
	spec: SortGrammarSpec,
	keys: readonly (readonly [string, SortDirection])[],
): SortValue | null {
	const rendered = keys.map(([field, direction]) => renderSortKey(spec, field, direction))
	if (rendered.length <= 1) return rendered[0] ?? null
	if (spec.join === REPEATED_KEYS) return rendered
	return spec.join === null ? null : rendered.join(spec.join)
}

/**
 * A key with a direction token the grammar does not have; `null` where ascending has no token of
 * its own, since a swapped token there would read as part of the field name.
 */
export function renderUnknownDirection(spec: SortGrammarSpec, field: string, token: string): string | null {
	if (spec.asc === "" || spec.desc === "") return null
	return spec.term.replace(/\{(field|direction)\}/g, (_whole, name: string) => (name === "field" ? field : token))
}
