/**
 * One renderer for every filter grammar.
 *
 * The three named grammars oat infers — postgrest, colon, equality — are presets of the same
 * description a document or config can declare as a template, so a term is written one way no
 * matter where its grammar came from. Anything a grammar cannot express renders as `null`: the
 * check that wanted it stands down instead of sending a guess the backend would misread.
 */

import { FILTER_OPS, type FilterOp } from "./query-capabilities.ts"
import { MissingValueError } from "../errors/missing-value.ts"

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
	 * a group, or — one parameter per field — distinct parameters.
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

const COLON_OPS: readonly FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "like"]

const identityOps = (ops: readonly FilterOp[]): Partial<Record<FilterOp, string>> =>
	Object.fromEntries(ops.map((op) => [op, op]))

/** The grammars oat recognises by name, as templates. */
export const FILTER_PRESETS = {
	colon: {
		and: { join: "," },
		escape: {},
		likeWildcard: "*",
		mixed: false,
		ops: identityOps(COLON_OPS),
		or: "none",
		param: "filter",
		reserved: "",
		term: "{field}={op}:{value}",
	},
	equality: {
		and: "params",
		escape: {},
		likeWildcard: "*",
		mixed: false,
		ops: { eq: "eq" },
		or: "none",
		param: "field",
		reserved: "",
		term: "{value}",
	},
	/* A grammar nobody named: every operator is unwritable, so every filter check stands down. */
	unrecognised: {
		and: "repeat",
		escape: {},
		likeWildcard: "*",
		mixed: false,
		ops: {},
		or: "none",
		param: "filter",
		reserved: "",
		term: "{field}{op}{value}",
	},
	postgrest: {
		and: { group: "and({terms})", join: "," },
		escape: {},
		likeWildcard: "*",
		list: { close: ")", join: ",", open: "(" },
		mixed: true,
		null: { is: "{field}.is.null", not: "{field}.is.notnull" },
		ops: identityOps(FILTER_OPS.filter((op) => op !== "is")),
		or: { group: "or({terms})", join: "," },
		param: "filter",
		reserved: "",
		term: "{field}.{op}.{value}",
	},
} as const satisfies Record<string, FilterGrammarSpec>

export function canWriteOp(spec: FilterGrammarSpec, op: FilterOp): boolean {
	if (op === "is") return spec.null !== undefined
	if (spec.ops[op] === undefined) return false
	return (op !== "in" && op !== "nin") || spec.list !== undefined
}

/** Whether terms that must all hold can share one filter value — the prerequisite for capping them. */
export function canGroupAnd(spec: FilterGrammarSpec): boolean {
	return typeof spec.and === "object" && "group" in spec.and
}

export function canWriteOr(spec: FilterGrammarSpec): boolean {
	return spec.param === "filter" && spec.or !== "none"
}

const PLACEHOLDER = /\{(conj|field|op|value|terms)\}/g

function fill(template: string, pieces: Partial<Record<string, string>>): string | null {
	let missing = false
	const out = template.replace(PLACEHOLDER, (whole, name: string) => {
		const piece = pieces[name]
		if (piece === undefined) missing = true
		return piece ?? whole
	})
	return missing ? null : out
}

function scalar(spec: FilterGrammarSpec, value: string | number | boolean | null): string | null {
	/* Typed away, and still reachable from a record without the field: never write it as text. */
	if (value === undefined) throw new MissingValueError("a filter value")
	let text = value === null ? "null" : String(value)
	/* A replacement already in the value would read back as the character it stands for. */
	for (const replacement of Object.values(spec.escape)) if (text.includes(replacement)) return null
	for (const [char, replacement] of Object.entries(spec.escape)) text = text.split(char).join(replacement)
	for (const char of spec.reserved) if (text.includes(char)) return null
	return text
}

function nullToken(value: FilterTermValue): "is" | "not" | null {
	if (value === null || value === "null") return "is"
	if (value === "notnull" || value === "not.null") return "not"
	return null
}

/** One predicate as the text of a term, without its parameter. */
export function renderFragment(
	spec: FilterGrammarSpec,
	predicate: FilterPredicate,
	conj: "and" | "or" = "and",
): string | null {
	const { field, op, value } = predicate
	if (!canWriteOp(spec, op)) return null
	const pieces: Record<string, string> = { field }
	const token = spec.conj?.[conj]
	if (token !== undefined) pieces.conj = token
	if (op === "is") {
		const which = nullToken(value)
		const templates = spec.null
		return which === null || templates === undefined ? null : fill(templates[which], pieces)
	}
	pieces.op = spec.ops[op] ?? op
	if (op === "in" || op === "nin") {
		const list = spec.list
		if (list === undefined) return null
		const members = typeof value === "object" && value !== null ? value : [value]
		/* With nothing around the list, no members reads as one empty value. */
		if (members.length === 0 && list.open === "" && list.close === "") return null
		const spelled = members.map((item) => scalar(spec, item))
		if (spelled.some((item) => item === null)) return null
		pieces.value = `${list.open}${spelled.join(list.join)}${list.close}`
		return fill(spec.term, pieces)
	}
	if (typeof value === "object" && value !== null) return null
	const spelled = scalar(spec, value)
	if (spelled === null) return null
	pieces.value = spelled
	return fill(spec.term, pieces)
}

/** One predicate as query parameters. */
export function renderTerm(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	predicate: FilterPredicate,
): Record<string, string> | null {
	const key = spec.param === "field" ? predicate.field : filterParam
	if (key === undefined) return null
	const fragment = renderFragment(spec, predicate)
	return fragment === null ? null : { [key]: fragment }
}

function grouped(group: TermGroup, fragments: readonly string[]): string | null {
	return fill(group.group, { terms: fragments.join(group.join) })
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
	const fragments = predicates.map((predicate) => renderFragment(spec, predicate))
	if (fragments.some((fragment) => fragment === null)) return null
	const value = combined(spec.and, fragments as string[])
	return value === null ? null : { [filterParam]: value }
}

function combined(
	how: "repeat" | { join: string } | TermGroup,
	fragments: string[],
): string | readonly string[] | null {
	if (how === "repeat") return fragments
	if ("group" in how) return grouped(how, fragments)
	return fragments.join(how.join)
}

/** Predicates of which one must hold, as query parameters; `null` when the grammar has no `or`. */
export function renderOr(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	predicates: readonly FilterPredicate[],
): FilterQuery | null {
	if (!canWriteOr(spec) || filterParam === undefined) return null
	if (spec.or === "terms") {
		if (spec.and === "params") return null
		const fragments = predicates.map((predicate) => renderFragment(spec, predicate, "or"))
		if (fragments.some((fragment) => fragment === null)) return null
		const value = combined(spec.and, fragments as string[])
		return value === null ? null : { [filterParam]: value }
	}
	if (spec.or === "none") return null
	const fragments = predicates.map((predicate) => renderFragment(spec, predicate))
	if (fragments.some((fragment) => fragment === null)) return null
	const value = grouped(spec.or, fragments as string[])
	return value === null ? null : { [filterParam]: value }
}

/** `a AND (b OR c)` as one filter value; `null` unless the grammar groups both and lets them nest. */
export function renderAndOfOr(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	first: FilterPredicate,
	either: readonly FilterPredicate[],
): Record<string, string> | null {
	if (!spec.mixed || filterParam === undefined || spec.or === "none" || spec.or === "terms") return null
	if (typeof spec.and !== "object" || !("group" in spec.and)) return null
	const head = renderFragment(spec, first)
	const tail = either.map((predicate) => renderFragment(spec, predicate))
	if (head === null || tail.some((fragment) => fragment === null)) return null
	const inner = grouped(spec.or, tail as string[])
	if (inner === null) return null
	const value = grouped(spec.and, [head, inner])
	return value === null ? null : { [filterParam]: value }
}

/* ------------------------------------------------------------- declared form */

export type ParsedGrammar = { ok: true; spec: FilterGrammarSpec } | { ok: false; error: string }

const fail = (error: string): ParsedGrammar => ({ error, ok: false })

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0

function placeholders(template: string): Set<string> {
	return new Set(Array.from(template.matchAll(PLACEHOLDER), (match) => match[1] ?? ""))
}

/** The characters a template writes around its placeholders: a value carrying one would split the term. */
function literals(template: string): string {
	return template.replace(PLACEHOLDER, "")
}

function readGroup(raw: unknown, key: string): TermGroup | string {
	if (!isRecord(raw) || !nonEmpty(raw.group)) return `${key} must be a group: { group: "…{terms}…", join?: "," }`
	const names = placeholders(raw.group)
	if (!names.has("terms") || names.size !== 1) return `${key}.group must hold {terms} and no other placeholder`
	const join = raw.join ?? ","
	if (!nonEmpty(join)) return `${key}.join must be a non-empty string`
	return { group: raw.group, join }
}

/**
 * The declared object form of a filter grammar, validated. An error names the key at fault so the
 * gap a document records says what to fix.
 */
export function parseFilterGrammar(raw: unknown): ParsedGrammar {
	if (!isRecord(raw)) return fail("grammar must be a preset name or an object with a term template")
	if (!nonEmpty(raw.term)) return fail("term must be a template such as {conj}_{field}_{op}_{value}")
	const param = raw.param ?? "{filter}"
	if (param !== "{filter}" && param !== "{field}") return fail('param must be "{filter}" or "{field}"')
	const names = placeholders(raw.term)
	if (!names.has("value")) return fail("term must hold {value}")
	if (param === "{filter}" && !names.has("field")) return fail("term must hold {field} unless param is {field}")
	if (names.has("terms")) return fail("term must not hold {terms}")

	if (!isRecord(raw.ops)) return fail("ops must map oat operators to the grammar's tokens")
	const ops: Partial<Record<FilterOp, string>> = {}
	for (const [op, token] of Object.entries(raw.ops)) {
		if (!(FILTER_OPS as readonly string[]).includes(op) || op === "is") {
			return fail(`ops.${op} is not an operator oat writes (null tests go under null)`)
		}
		if (!nonEmpty(token)) return fail(`ops.${op} must be a non-empty token`)
		ops[op as FilterOp] = token
	}
	if (Object.keys(ops).length === 0) return fail("ops must list at least one operator")
	if (!names.has("op") && Object.keys(ops).length > 1) return fail("term must hold {op} when ops lists several")

	let conj: FilterGrammarSpec["conj"]
	if (raw.conj !== undefined) {
		if (!isRecord(raw.conj) || !nonEmpty(raw.conj.and)) return fail("conj must be { and: token, or?: token }")
		if (raw.conj.or !== undefined && !nonEmpty(raw.conj.or)) return fail("conj.or must be a non-empty token")
		conj = { and: raw.conj.and, ...(raw.conj.or === undefined ? {} : { or: raw.conj.or as string }) }
	}
	if (names.has("conj") && conj === undefined) return fail("conj must be declared when term holds {conj}")

	let nullTerms: FilterGrammarSpec["null"]
	if (raw.null !== undefined) {
		if (!isRecord(raw.null) || !nonEmpty(raw.null.is) || !nonEmpty(raw.null.not)) {
			return fail("null must be { is: template, not: template }")
		}
		for (const key of ["is", "not"] as const) {
			const held = placeholders(raw.null[key] as string)
			if (held.has("value") || held.has("op") || held.has("terms"))
				return fail(`null.${key} may hold only {conj} and {field}`)
			if (held.has("conj") && conj === undefined) return fail(`conj must be declared when null.${key} holds {conj}`)
		}
		nullTerms = { is: raw.null.is as string, not: raw.null.not as string }
	}

	let list: FilterGrammarSpec["list"]
	if (raw.list !== undefined) {
		if (!nonEmpty(raw.list)) return fail('list must be the joiner for in and nin values, such as ","')
		list = { close: "", join: raw.list, open: "" }
	}

	let and: FilterGrammarSpec["and"]
	if (param === "{field}") {
		if (raw.combine !== undefined)
			return fail("combine does not apply when param is {field}: each field is its own parameter")
		and = "params"
	} else if (raw.combine === undefined || raw.combine === "repeat") {
		and = "repeat"
	} else if (isRecord(raw.combine) && raw.combine.group !== undefined) {
		const group = readGroup(raw.combine, "combine")
		if (typeof group === "string") return fail(group)
		and = group
	} else if (isRecord(raw.combine) && nonEmpty(raw.combine.join)) {
		and = { join: raw.combine.join }
	} else {
		return fail('combine must be "repeat", { join: "," } or { group: "…{terms}…" }')
	}

	let or: FilterGrammarSpec["or"]
	if (raw.or === undefined || raw.or === "none") {
		or = "none"
	} else if (raw.or === "terms") {
		if (conj?.or === undefined || !names.has("conj")) return fail("or: terms needs conj.or and {conj} in term")
		if (and === "params") return fail("or: terms needs param {filter}")
		or = "terms"
	} else {
		if (param === "{field}") return fail("or needs param {filter}")
		const group = readGroup(raw.or, "or")
		if (typeof group === "string") return fail(group)
		or = group
	}

	if (raw.mixed !== undefined && raw.mixed !== false) {
		return fail("mixed must be false: oat never assumes how and and or nest in a declared grammar")
	}

	const escape: Record<string, string> = {}
	if (raw.escape !== undefined) {
		if (!isRecord(raw.escape)) return fail("escape must map single characters to replacements")
		for (const [char, replacement] of Object.entries(raw.escape)) {
			if (Array.from(char).length !== 1 || !nonEmpty(replacement)) {
				return fail(`escape["${char}"] must map one character to a non-empty replacement`)
			}
			escape[char] = replacement
		}
	}

	const likeMatches = raw.likeMatches ?? "pattern"
	if (likeMatches !== "pattern" && likeMatches !== "contains")
		return fail('likeMatches must be "pattern" or "contains"')

	const separators = [
		literals(raw.term),
		list?.join ?? "",
		typeof and === "object" ? and.join : "",
		typeof or === "object" ? or.join : "",
	].join("")
	return {
		ok: true,
		spec: {
			and,
			escape,
			likeWildcard: likeMatches === "pattern" ? "%" : null,
			mixed: false,
			ops,
			or,
			param: param === "{field}" ? "field" : "filter",
			reserved: Array.from(new Set(separators)).join(""),
			term: raw.term,
			...(conj === undefined ? {} : { conj }),
			...(list === undefined ? {} : { list }),
			...(nullTerms === undefined ? {} : { null: nullTerms }),
		},
	}
}

/** A declared template in one line, for `plan` and `doctor`: what oat will write, and what it cannot. */
export function describeFilterGrammar(spec: FilterGrammarSpec): string {
	const ops = Object.entries(spec.ops)
		.map(([op, token]) => `${op}=${token}`)
		.join(" ")
	const and = typeof spec.and === "string" ? spec.and : "group" in spec.and ? spec.and.group : `join "${spec.and.join}"`
	const or = typeof spec.or === "string" ? spec.or : spec.or.group
	const unwritable = FILTER_OPS.filter((op) => !canWriteOp(spec, op))
	return [
		`template ${spec.term}`,
		`ops ${ops}`,
		spec.null === undefined ? "" : `null ${spec.null.is} / ${spec.null.not}`,
		spec.list === undefined ? "" : `list "${spec.list.join}"`,
		`combine ${and}`,
		`or ${or}`,
		spec.likeWildcard === null ? "like matches a substring" : "",
		unwritable.length === 0 ? "" : `cannot write ${unwritable.join(",")}`,
	]
		.filter(Boolean)
		.join("  ")
}

/**
 * A term with an operator token the grammar does not have, for asking whether the backend refuses
 * it. `null` when the grammar has no operator token to swap.
 */
export function renderUnknownOp(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	field: string,
	token: string,
	value: string,
): Record<string, string> | null {
	if (spec.param !== "filter" || filterParam === undefined || !spec.term.includes("{op}")) return null
	const conj = spec.conj?.and
	const spelled = scalar(spec, value)
	if (spelled === null) return null
	const term = fill(spec.term, { field, op: token, value: spelled, ...(conj === undefined ? {} : { conj }) })
	return term === null ? null : { [filterParam]: term }
}

/**
 * An equality term with one required piece left out — its conjunction where it has one, else its
 * operator, together with the literal that joined that piece to its neighbour. `null` when the
 * grammar's terms have neither.
 */
export function renderMalformed(
	spec: FilterGrammarSpec,
	filterParam: string | undefined,
	field: string,
	value: string,
): Record<string, string> | null {
	if (spec.param !== "filter" || filterParam === undefined) return null
	const piece = spec.term.includes("{conj}") ? "{conj}" : spec.term.includes("{op}") ? "{op}" : null
	if (piece === null) return null
	const at = spec.term.indexOf(piece)
	const before = spec.term.slice(0, at)
	const after = spec.term.slice(at + piece.length)
	/* The literal after the piece joins it to the next one; at the end, the literal before it does. */
	const trailing = /^[^{]*/.exec(after)?.[0] ?? ""
	const leading = /[^}]*$/.exec(before)?.[0] ?? ""
	const template =
		after.length > trailing.length || before.length === 0
			? before + after.slice(trailing.length)
			: before.slice(0, before.length - leading.length) + after
	const spelled = scalar(spec, value)
	if (spelled === null) return null
	const conj = spec.conj?.and
	const term = fill(template, {
		field,
		op: spec.ops.eq ?? "eq",
		value: spelled,
		...(conj === undefined ? {} : { conj }),
	})
	return term === null ? null : { [filterParam]: term }
}
