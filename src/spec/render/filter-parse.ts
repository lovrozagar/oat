/** The declared object form of a filter grammar, read into the template the renderer writes with. */

import type { FilterGrammarSpec, ParsedGrammar } from "./filter-types.ts"
import { PLACEHOLDER } from "./filter-term.ts"
import {
	type Draft,
	type Raw,
	type Step,
	isRecord,
	nonEmpty,
	placeholders,
	readAnd,
	readConj,
	readEscape,
	readLikeMatches,
	readList,
	readMixed,
	readNull,
	readOps,
	readOr,
} from "./filter-parse-steps.ts"

const fail = (error: string): ParsedGrammar => ({ error, ok: false })

/** The steps after the term, in the order their errors take precedence. */
const STEPS: readonly Step[] = [
	readOps,
	readConj,
	readNull,
	readList,
	readAnd,
	readOr,
	readMixed,
	readEscape,
	readLikeMatches,
]

/** The characters a template writes around its placeholders: a value carrying one would split the term. */
function literals(template: string): string {
	return template.replace(PLACEHOLDER, "")
}

/** The draft every step starts from, or the error that the term or its parameter has. */
function startDraft(raw: Raw): Draft | string {
	if (!nonEmpty(raw.term)) return "term must be a template such as {conj}_{field}_{op}_{value}"
	const param = raw.param ?? "{filter}"
	if (param !== "{filter}" && param !== "{field}") return 'param must be "{filter}" or "{field}"'
	const names = placeholders(raw.term)
	if (!names.has("value")) return "term must hold {value}"
	if (param === "{filter}" && !names.has("field")) return "term must hold {field} unless param is {field}"
	if (names.has("terms")) return "term must not hold {terms}"
	return { and: "repeat", escape: {}, likeMatches: "pattern", names, ops: {}, or: "none", param, raw, term: raw.term }
}

function finish(draft: Draft): FilterGrammarSpec {
	const { and, or, list, conj, nullTerms } = draft
	const separators = [
		literals(draft.term),
		list?.join ?? "",
		typeof and === "object" ? and.join : "",
		typeof or === "object" ? or.join : "",
	].join("")
	return {
		and,
		escape: draft.escape,
		likeWildcard: draft.likeMatches === "pattern" ? "%" : null,
		mixed: false,
		ops: draft.ops,
		or,
		param: draft.param === "{field}" ? "field" : "filter",
		reserved: Array.from(new Set(separators)).join(""),
		term: draft.term,
		...(conj === undefined ? {} : { conj }),
		...(list === undefined ? {} : { list }),
		...(nullTerms === undefined ? {} : { null: nullTerms }),
	}
}

/**
 * The declared object form of a filter grammar, validated. An error names the key at fault so the
 * gap a document records says what to fix.
 */
export function parseFilterGrammar(raw: unknown): ParsedGrammar {
	if (!isRecord(raw)) return fail("grammar must be a preset name or an object with a term template")
	const draft = startDraft(raw)
	if (typeof draft === "string") return fail(draft)
	for (const step of STEPS) {
		const error = step(draft)
		if (error !== undefined) return fail(error)
	}
	return { ok: true, spec: finish(draft) }
}
