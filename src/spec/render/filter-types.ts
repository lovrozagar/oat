/**
 * One renderer for every filter grammar.
 *
 * The three named grammars oat infers — postgrest, colon, equality — are presets of the same
 * description a document or config can declare as a template, so a term is written one way no
 * matter where its grammar came from. Anything a grammar cannot express renders as `null`: the
 * check that wanted it stands down instead of sending a guess the backend would misread.
 */

import type { FilterOp } from "../../config/types/query.ts"

export type FilterTermValue = string | number | boolean | null | readonly (string | number | boolean | null)[]

/** A query a check sends; an array value is the parameter repeated once per item. */
export type FilterQuery = Record<string, string | readonly string[]>

/** One predicate, before it is spelled. */
export interface FilterPredicate {
	field: string
	op: FilterOp
	value: FilterTermValue
}

/** A template that joins terms: `{terms}` is where they go, separated by `join`. */
export interface TermGroup {
	group: string
	join: string
}

export interface FilterGrammarSpec {
	/** Where a term goes: the endpoint's filter parameter, or a parameter named after the field. */
	param: "filter" | "field"
	/** One term, with `{conj}`, `{field}`, `{op}` and `{value}` placeholders. */
	term: string
	/** The conjunction token a term carries, when the grammar has one. */
	conj?: { and: string; or?: string }
	/** The token for each operator the grammar can write; an operator absent here cannot be written. */
	ops: Partial<Record<FilterOp, string>>
	/** Whole terms testing for null, with `{conj}` and `{field}` placeholders. */
	null?: { is: string; not: string }
	/** How the values of `in` and `nin` are spelled; absent when the grammar has no list. */
	list?: { open: string; join: string; close: string }
	/**
	 * How two or more terms that must all hold are sent: the parameter repeated, one value joined,
	 * a group, or — one parameter per field — distinct parameters. `params` goes with param
	 * `field` and only with it.
	 */
	and: "repeat" | "params" | { join: string } | TermGroup
	/** How terms of which one must hold are sent: not at all, as terms carrying the `or` token, or a group. */
	or: "none" | "terms" | TermGroup
	/** Whether an and-group may hold an or-group. Only a grammar that groups both can say so. */
	mixed: boolean
	/** Replacements for characters a value cannot carry as they are. */
	escape: Readonly<Record<string, string>>
	/** Characters a value may not carry once escaped: a term holding one would read as another. */
	reserved: string
	/**
	 * The wildcard a `like` value matches any run of characters with, or `null` when the value is a
	 * bare substring. Today's grammars write PostgREST's `*`, which leaves `%` literal; a declared
	 * pattern grammar means `%`.
	 */
	likeWildcard: string | null
}

export type ParsedGrammar = { ok: true; spec: FilterGrammarSpec } | { ok: false; error: string }
