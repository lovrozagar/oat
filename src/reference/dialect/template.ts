/*
 * The template dialect's terms, parsed on their own terms rather than through oat's renderer: a
 * reference that reused the renderer would agree with it by construction and prove nothing.
 * A value never holds an underscore (it is written `~`), so the last `_op_` in a term is its operator.
 */
const TEMPLATE_TERM = /^(and|or)_(.+)_(eq|ne|gt|gte|lt|lte|like|in)_([^_]*)$/s
const TEMPLATE_NULL = /^(and|or)_(.+)_(is|isn)_null$/s
/* An operator this grammar lacks reaches the canonical layer as one, which refuses it. */
const TEMPLATE_UNKNOWN_OP = /^(and|or)_(.+)_([a-z]+)_([^_]*)$/s
const TEMPLATE_OPS: Record<string, string> = {
	eq: "eq",
	gt: "gt",
	gte: "gte",
	in: "in",
	like: "like",
	lt: "lt",
	lte: "lte",
	ne: "neq",
}

/* Every group of these patterns takes part in every match. */
type Groups3 = [string, string, string, string]
type Groups4 = [string, string, string, string, string]

const unescapeTemplate = (value: string): string => value.replaceAll("~", "_")

/** Repeated `and_…` terms must all hold; `or_…` terms, at least one of them. */
export function fromTemplateTerms(terms: readonly string[]): string | null {
	const all: string[] = []
	const any: string[] = []
	for (const term of terms) {
		const read = templateTerm(term)
		if (read === null) return null
		;(read.conj === "and" ? all : any).push(read.canonical)
	}
	if (any.length > 0) all.push(any.length === 1 ? (any[0] as string) : `or(${any.join(",")})`)
	if (all.length === 0) return null
	return all.length === 1 ? (all[0] as string) : `and(${all.join(",")})`
}

/* One term as its combinator and its canonical `field.op.value`; null when it is no term at all. */
function templateTerm(term: string): { conj: string; canonical: string } | null {
	const nullTest = TEMPLATE_NULL.exec(term)
	if (nullTest !== null) {
		const [, conj, field, test] = nullTest as unknown as Groups3
		return { canonical: `${field}.is.${test === "is" ? "null" : "notnull"}`, conj }
	}
	const match = TEMPLATE_TERM.exec(term)
	if (match !== null) {
		const [, conj, field, op, value] = match as unknown as Groups4
		return { canonical: knownTerm(field, op, value), conj }
	}
	const unknown = TEMPLATE_UNKNOWN_OP.exec(term)
	if (unknown === null) return null
	const [, conj, field, op, value] = unknown as unknown as Groups4
	return { canonical: `${field}.${op}.${unescapeTemplate(value)}`, conj }
}

/* `in` values are comma-joined, and `like` matches a bare substring. */
function knownTerm(field: string, op: string, value: string): string {
	if (op === "in") return `${field}.in.(${value.split(",").map(unescapeTemplate).join(",")})`
	if (op === "like") return `${field}.like.*${unescapeTemplate(value)}*`
	return `${field}.${TEMPLATE_OPS[op]}.${unescapeTemplate(value)}`
}
