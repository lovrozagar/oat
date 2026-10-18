/** How a listing request is read in the dialect's spelling, and how its answer is shaped. */

import type { Dialect } from "../dialect/types.ts"
import type { ListingResult } from "../listing/types.ts"
import type { EntityDef } from "../model/types.ts"
import { fieldsWhere } from "../model/fields.ts"
import type { Row } from "../store-api.ts"
import type { Json } from "./wire.ts"

/**
 * Rewrites a sort expression from the dialect's grammar into the canonical `field.asc` the
 * listing parses, so the storage layer never learns which spelling arrived.
 *
 * Unparseable terms are passed through untouched rather than dropped: the parser rejects an
 * unknown sort field with a 400, which is the correct answer to a malformed sort and keeps a bad
 * expression from silently becoming no sort at all.
 */
export function toCanonicalOrder(expression: string | undefined, dialect: Dialect): string | undefined {
	if (expression === undefined || expression === "") return undefined
	const grammar = dialect.sortGrammar ?? "dotted"
	if (grammar === "dotted") return expression
	return expression
		.split(",")
		.map((term) => term.trim())
		.filter(Boolean)
		.map((term) => canonicalTerm(term, grammar))
		.join(",")
}

function canonicalTerm(term: string, grammar: NonNullable<Dialect["sortGrammar"]>): string {
	/* `name_descending`, read on its own terms: the last `_` before a known direction. */
	if (grammar === "template") {
		const match = /^(.+)_(ascending|descending)$/s.exec(term)
		if (match !== null) return `${match[1]}.${match[2] === "descending" ? "desc" : "asc"}`
		/* A direction this grammar lacks reaches the canonical layer as one, which refuses it. */
		const unknown = /^(.+)_([a-z]+)$/s.exec(term)
		return unknown === null ? term : `${unknown[1]}.${unknown[2]}`
	}
	if (grammar === "prefixed") return term.startsWith("-") ? `${term.slice(1)}.desc` : `${term}.asc`
	const index = term.lastIndexOf(grammar === "colon" ? ":" : " ")
	if (index === -1) return `${term}.asc`
	const field = term.slice(0, index).trim()
	const direction = term
		.slice(index + 1)
		.trim()
		.toLowerCase()
	return direction === "asc" || direction === "desc" ? `${field}.${direction}` : term
}

/**
 * Collects one-parameter-per-field equality filters into a canonical expression.
 *
 * Only fields the document declares filterable are honoured; anything else falls through to the
 * unknown-parameter path, so a caller misspelling a field still gets told rather than silently
 * receiving the whole collection.
 */
export function equalityFilter(url: URL, entity: EntityDef): string | null {
	const terms: string[] = []
	for (const field of fieldsWhere(entity, "filterable")) {
		const value = url.searchParams.get(field)
		if (value !== null) terms.push(`${field}.eq.${value}`)
	}
	if (terms.length === 0) return null
	return terms.length === 1 ? (terms[0] as string) : `and(${terms.join(",")})`
}

/** The sparse-fieldset parameter's name, whether the resource lives in it or not. */
export function selectParam(dialect: Dialect, entity: EntityDef): string {
	return dialect.selectGrammar === "bracketed" ? `${dialect.params.select}[${entity.name}]` : dialect.params.select
}

/**
 * Builds a listing response in whichever pagination model the dialect speaks.
 *
 * Two genuinely different models, not two spellings: an envelope carrying the array alongside a
 * total and a more-pages flag, or a bare array whose pagination facts travel in a `Link` header.
 * Keeping both here means the routing code never branches on it.
 */
export function paginated(
	dialect: Dialect,
	entity: EntityDef,
	requestUrl: URL,
	result: ListingResult,
): { body: Json | Row[]; headers: Record<string, string> } {
	const env = dialect.envelope
	if (env !== null) {
		const envelope: Json = { [env.collection ?? entity.plural]: result.items }
		/* Only the facts this API publishes. */
		if (env.hasMore !== undefined) envelope[env.hasMore] = result.hasMore
		if (env.limit !== undefined) envelope[env.limit] = result.limit
		if (env.page !== undefined) envelope[env.page] = result.page
		if (env.total !== undefined) envelope[env.total] = result.count
		if (env.nextCursor !== undefined) envelope[env.nextCursor] = result.nextCursor
		return { body: envelope, headers: {} }
	}
	/* Root array: the only pagination signal is the header, so a caller learns there is more by
	 * being handed the URL that returns it — never by a field. */
	const offsetParam = dialect.params.offset
	if (!result.hasMore || offsetParam === undefined) return { body: result.items, headers: {} }
	const next = new URL(requestUrl.toString())
	next.searchParams.set(offsetParam, String(result.offset + result.items.length))
	return { body: result.items, headers: { link: `<${next.pathname}${next.search}>; rel="next"` } }
}

/** The page a plain listing asks for, or `null` when a paging value is not a valid one. */
export function staleWindow(
	url: URL,
	dialect: Dialect,
	entity: EntityDef,
): { limit: number; offset: number; page: number } | null {
	const read = (name: string | undefined, min: number): number | undefined | null => {
		const raw = name === undefined ? null : url.searchParams.get(name)
		if (raw === null) return undefined
		const value = Number(raw)
		return raw.trim() !== "" && Number.isInteger(value) && value >= min ? value : null
	}
	const limit = read(dialect.params.limit, 1)
	const page = read(dialect.params.page, 1)
	const offset = read(dialect.params.offset, 0)
	if (limit === null || page === null || offset === null) return null
	const size = Math.min(limit ?? entity.defaultLimit, entity.maxLimit)
	const start = offset ?? ((page ?? 1) - 1) * size
	return { limit: size, offset: start, page: page ?? Math.floor(start / size) + 1 }
}
