/**
 * Terms written wrong on purpose, to ask whether a backend refuses them: an operator token the
 * grammar does not have, and an equality term with a required piece left out.
 */

import type { FilterGrammarSpec } from "./filter-types.ts"
import { fill, scalar } from "./filter-term.ts"

/** A term to write under a grammar: its filter parameter, field and value. */
export interface ProbeTerm {
	spec: FilterGrammarSpec
	filterParam: string | undefined
	field: string
	value: string
}

/** The pieces a term template fills. A template oat writes holds no placeholder beyond these. */
function filled(template: string, pieces: Record<string, string>, spec: FilterGrammarSpec): string {
	const conj = spec.conj?.and
	return fill(template, { ...pieces, ...(conj === undefined ? {} : { conj }) }) as string
}

/**
 * A term with an operator token the grammar does not have, for asking whether the backend refuses
 * it. `null` when the grammar has no operator token to swap.
 */
export function renderUnknownOp(term: ProbeTerm, token: string): Record<string, string> | null {
	const { spec, filterParam, field, value } = term
	if (spec.param !== "filter" || filterParam === undefined || !spec.term.includes("{op}")) return null
	const spelled = scalar(spec, value)
	if (spelled === null) return null
	return { [filterParam]: filled(spec.term, { field, op: token, value: spelled }, spec) }
}

/**
 * `term` without `piece`, together with the literal that joined that piece to its neighbor: the
 * literal after it, or — at the end — the literal before it.
 */
function withoutPiece(term: string, piece: string): string {
	const at = term.indexOf(piece)
	const before = term.slice(0, at)
	const after = term.slice(at + piece.length)
	/* Both patterns match, if only the empty string. */
	const trailing = (/^[^{]*/.exec(after) as RegExpExecArray)[0]
	const leading = (/[^}]*$/.exec(before) as RegExpExecArray)[0]
	return after.length > trailing.length || before.length === 0
		? before + after.slice(trailing.length)
		: before.slice(0, before.length - leading.length) + after
}

/**
 * An equality term with one required piece left out — its conjunction where it has one, else its
 * operator, together with the literal that joined that piece to its neighbor. `null` when the
 * grammar's terms have neither.
 */
export function renderMalformed(term: ProbeTerm): Record<string, string> | null {
	const { spec, filterParam, field, value } = term
	if (spec.param !== "filter" || filterParam === undefined) return null
	const piece = spec.term.includes("{conj}") ? "{conj}" : spec.term.includes("{op}") ? "{op}" : null
	if (piece === null) return null
	const spelled = scalar(spec, value)
	if (spelled === null) return null
	const template = withoutPiece(spec.term, piece)
	return { [filterParam]: filled(template, { field, op: spec.ops.eq ?? "eq", value: spelled }, spec) }
}
