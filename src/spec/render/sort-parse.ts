/** The declared object form of a sort grammar, read and described. */

import { REPEATED_KEYS, type SortGrammarSpec } from "./sort.ts"

export type ParsedSortGrammar = { ok: true; spec: SortGrammarSpec } | { ok: false; error: string }

const fail = (error: string): ParsedSortGrammar => ({ error, ok: false })
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0

/** The declared nulls tokens, `undefined` when none are declared, or an error. */
function readNulls(raw: unknown): SortGrammarSpec["nulls"] | string {
	if (raw === undefined) return undefined
	if (!isRecord(raw) || !nonEmpty(raw.first) || !nonEmpty(raw.last))
		return "nulls must be { first: token, last: token }"
	return { first: raw.first, last: raw.last }
}

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
	const nulls = readNulls(raw.nulls)
	if (typeof nulls === "string") return fail(nulls)
	return {
		ok: true,
		spec: { asc: raw.asc, desc: raw.desc, join, term: raw.term, ...(nulls === undefined ? {} : { nulls }) },
	}
}

function describeJoin(join: string | null): string {
	if (join === null) return "one key only"
	return join === REPEATED_KEYS ? "several keys as the parameter repeated" : `join "${join}"`
}

/** A declared sort template in one line, for `plan` and `doctor`. */
export function describeSortGrammar(spec: SortGrammarSpec): string {
	return [
		`template ${spec.term}`,
		`asc ${spec.asc === "" ? "(bare)" : spec.asc}`,
		`desc ${spec.desc}`,
		describeJoin(spec.join),
		spec.nulls === undefined ? "" : `nulls ${spec.nulls.first} / ${spec.nulls.last}`,
	]
		.filter(Boolean)
		.join("  ")
}
