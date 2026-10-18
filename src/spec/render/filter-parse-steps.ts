/**
 * The steps that read a declared filter grammar, one key each. A step fills its part of the draft
 * and returns `undefined`, or returns an error naming the key at fault.
 */

import type { FilterOp } from "../../config/types/query.ts"
import { FILTER_OPS } from "../query/ops.ts"
import type { FilterGrammarSpec, TermGroup } from "./filter-types.ts"
import { PLACEHOLDER } from "./filter-term.ts"

export type Raw = Record<string, unknown>

/** The grammar as read so far. `term`, `param` and `names` are known before any step runs. */
export interface Draft {
	raw: Raw
	term: string
	param: "{filter}" | "{field}"
	/** The placeholders `term` holds. */
	names: ReadonlySet<string>
	ops: Partial<Record<FilterOp, string>>
	conj?: FilterGrammarSpec["conj"]
	nullTerms?: FilterGrammarSpec["null"]
	list?: FilterGrammarSpec["list"]
	and: FilterGrammarSpec["and"]
	or: FilterGrammarSpec["or"]
	escape: Record<string, string>
	likeMatches: "pattern" | "contains"
}

export type Step = (draft: Draft) => string | undefined

export const isRecord = (value: unknown): value is Raw =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0

export function placeholders(template: string): Set<string> {
	return new Set(Array.from(template.matchAll(PLACEHOLDER), (match) => match[1] as string))
}

function readGroup(raw: unknown, key: string): TermGroup | string {
	if (!isRecord(raw) || !nonEmpty(raw.group)) return `${key} must be a group: { group: "…{terms}…", join?: "," }`
	const names = placeholders(raw.group)
	if (!names.has("terms") || names.size !== 1) return `${key}.group must hold {terms} and no other placeholder`
	const join = raw.join ?? ","
	if (!nonEmpty(join)) return `${key}.join must be a non-empty string`
	return { group: raw.group, join }
}

export const readOps: Step = (draft) => {
	const { raw, names } = draft
	if (!isRecord(raw.ops)) return "ops must map oat operators to the grammar's tokens"
	for (const [op, token] of Object.entries(raw.ops)) {
		if (!(FILTER_OPS as readonly string[]).includes(op) || op === "is") {
			return `ops.${op} is not an operator oat writes (null tests go under null)`
		}
		if (!nonEmpty(token)) return `ops.${op} must be a non-empty token`
		draft.ops[op as FilterOp] = token
	}
	const count = Object.keys(draft.ops).length
	if (count === 0) return "ops must list at least one operator"
	if (!names.has("op") && count > 1) return "term must hold {op} when ops lists several"
	return undefined
}

export const readConj: Step = (draft) => {
	const conj = draft.raw.conj
	if (conj !== undefined) {
		if (!isRecord(conj) || !nonEmpty(conj.and)) return "conj must be { and: token, or?: token }"
		if (conj.or !== undefined && !nonEmpty(conj.or)) return "conj.or must be a non-empty token"
		draft.conj = { and: conj.and, ...(conj.or === undefined ? {} : { or: conj.or as string }) }
	}
	if (draft.names.has("conj") && draft.conj === undefined) return "conj must be declared when term holds {conj}"
	return undefined
}

export const readNull: Step = (draft) => {
	const terms = draft.raw.null
	if (terms === undefined) return undefined
	if (!isRecord(terms) || !nonEmpty(terms.is) || !nonEmpty(terms.not)) {
		return "null must be { is: template, not: template }"
	}
	for (const key of ["is", "not"] as const) {
		const held = placeholders(terms[key] as string)
		if (held.has("value") || held.has("op") || held.has("terms")) return `null.${key} may hold only {conj} and {field}`
		if (held.has("conj") && draft.conj === undefined) return `conj must be declared when null.${key} holds {conj}`
	}
	draft.nullTerms = { is: terms.is as string, not: terms.not as string }
	return undefined
}

export const readList: Step = (draft) => {
	const list = draft.raw.list
	if (list === undefined) return undefined
	if (!nonEmpty(list)) return 'list must be the joiner for in and nin values, such as ","'
	draft.list = { close: "", join: list, open: "" }
	return undefined
}

export const readAnd: Step = (draft) => {
	const combine = draft.raw.combine
	if (draft.param === "{field}") {
		if (combine !== undefined) return "combine does not apply when param is {field}: each field is its own parameter"
		draft.and = "params"
	} else if (combine === undefined || combine === "repeat") {
		draft.and = "repeat"
	} else if (isRecord(combine) && combine.group !== undefined) {
		const group = readGroup(combine, "combine")
		if (typeof group === "string") return group
		draft.and = group
	} else if (isRecord(combine) && nonEmpty(combine.join)) {
		draft.and = { join: combine.join }
	} else {
		return 'combine must be "repeat", { join: "," } or { group: "…{terms}…" }'
	}
	return undefined
}

export const readOr: Step = (draft) => {
	const or = draft.raw.or
	if (or === undefined || or === "none") {
		draft.or = "none"
	} else if (or === "terms") {
		if (draft.conj?.or === undefined || !draft.names.has("conj")) return "or: terms needs conj.or and {conj} in term"
		if (draft.and === "params") return "or: terms needs param {filter}"
		draft.or = "terms"
	} else {
		if (draft.param === "{field}") return "or needs param {filter}"
		const group = readGroup(or, "or")
		if (typeof group === "string") return group
		draft.or = group
	}
	return undefined
}

export const readMixed: Step = (draft) =>
	draft.raw.mixed !== undefined && draft.raw.mixed !== false
		? "mixed must be false: oat never assumes how and and or nest in a declared grammar"
		: undefined

export const readEscape: Step = (draft) => {
	const escape = draft.raw.escape
	if (escape === undefined) return undefined
	if (!isRecord(escape)) return "escape must map single characters to replacements"
	for (const [char, replacement] of Object.entries(escape)) {
		if (Array.from(char).length !== 1 || !nonEmpty(replacement)) {
			return `escape["${char}"] must map one character to a non-empty replacement`
		}
		draft.escape[char] = replacement
	}
	return undefined
}

export const readLikeMatches: Step = (draft) => {
	const likeMatches = draft.raw.likeMatches ?? "pattern"
	if (likeMatches !== "pattern" && likeMatches !== "contains") return 'likeMatches must be "pattern" or "contains"'
	draft.likeMatches = likeMatches
	return undefined
}
