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

export type ParsedSortGrammar = { ok: true; spec: SortGrammarSpec } | { ok: false; error: string }

const fail = (error: string): ParsedSortGrammar => ({ error, ok: false })
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0

/** The declared object form of a sort grammar, validated; an error names the key at fault. */
export function parseSortGrammar(raw: unknown): ParsedSortGrammar {
	if (!isRecord(raw)) return fail("sortGrammar must be a preset name or an object with a term template")
	if (!nonEmpty(raw.term) || !raw.term.includes("{field}") || !raw.term.includes("{direction}")) {
		return fail("term must be a template holding {field} and {direction}, such as {field}_{direction}")
	}
	if (typeof raw.asc !== "string") return fail("asc must be the ascending token")
	if (!nonEmpty(raw.desc) || raw.desc === raw.asc) return fail("desc must be a non-empty token unlike asc")
	const join = raw.join === undefined ? "," : raw.join
	if (join !== null && !nonEmpty(join)) {
		return fail('join must separate several keys, be "repeat" to repeat the parameter, or be null for one key only')
	}
	let nulls: SortGrammarSpec["nulls"]
	if (raw.nulls !== undefined) {
		if (!isRecord(raw.nulls) || !nonEmpty(raw.nulls.first) || !nonEmpty(raw.nulls.last)) {
			return fail("nulls must be { first: token, last: token }")
		}
		nulls = { first: raw.nulls.first, last: raw.nulls.last }
	}
	return {
		ok: true,
		spec: { asc: raw.asc, desc: raw.desc, join, term: raw.term, ...(nulls === undefined ? {} : { nulls }) },
	}
}

/** A declared sort template in one line, for `plan` and `doctor`. */
export function describeSortGrammar(spec: SortGrammarSpec): string {
	return [
		`template ${spec.term}`,
		`asc ${spec.asc === "" ? "(bare)" : spec.asc}`,
		`desc ${spec.desc}`,
		spec.join === null
			? "one key only"
			: spec.join === REPEATED_KEYS
				? "several keys as the parameter repeated"
				: `join "${spec.join}"`,
		spec.nulls === undefined ? "" : `nulls ${spec.nulls.first} / ${spec.nulls.last}`,
	]
		.filter(Boolean)
		.join("  ")
}
