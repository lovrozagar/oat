import { fromTemplateTerms } from "./template.ts"
import type { Dialect } from "./types.ts"

/* `status=eq:active`: a field, an operator and a value. Every group takes part in every match. */
const COLON_TERM = /^([^=]+)=([a-z]+):(.*)$/s

/**
 * Rewrites a filter expression from a dialect's grammar into the canonical `field.op.value` the
 * stores parse, so the storage layer never has to know which dialect it is serving.
 *
 * Returns `null` when the expression is malformed, which the caller surfaces as a 400 — the same
 * treatment the canonical grammar gets.
 */
export function toCanonicalFilter(expression: string | readonly string[], dialect: Dialect): string | null {
	if (typeof expression !== "string") return dialect.grammar === "template" ? fromTemplateTerms(expression) : null
	if (dialect.grammar === "template") return fromTemplateTerms([expression])
	/* Already canonical: the postgrest grammar *is* the canonical form, and the equality grammar
	 * has no expression of its own — the per-field parameters were assembled into canonical terms
	 * before reaching here. Re-parsing that would reject a well-formed expression. */
	if (dialect.grammar === "postgrest" || dialect.grammar === "equality") return expression
	return fromColonTerms(expression)
}

/* `status=eq:active`, joined by commas. No grouping: the point of a second dialect is different
 * spelling, not a second expression language to maintain. */
function fromColonTerms(expression: string): string | null {
	const terms = expression
		.split(",")
		.map((term) => term.trim())
		.filter(Boolean)
	if (terms.length === 0) return null

	const canonical: string[] = []
	for (const term of terms) {
		const match = COLON_TERM.exec(term)
		if (match === null) return null
		const [, field, op, value] = match as unknown as [string, string, string, string]
		canonical.push(`${field}.${op}.${value}`)
	}
	return canonical.length === 1 ? (canonical[0] as string) : `and(${canonical.join(",")})`
}
