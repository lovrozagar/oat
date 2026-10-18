/** Which query parameter plays which role, by the aliases real APIs use and the schema they declare. */

import type { ParameterObject, SchemaObject } from "../types.ts"

export type Role = "filter" | "order" | "select" | "search" | "searchMode" | "limit" | "page" | "offset" | "cursor"

/*
 * Aliases seen across real APIs. Order matters only for readability; a parameter is matched
 * case-insensitively and with separators normalised, so `perPage`, `per_page` and `PerPage` are
 * one entry.
 */
const ALIASES: Readonly<Record<Role, readonly string[]>> = {
	cursor: ["cursor", "after", "starting_after", "next", "page_token", "continuation"],
	filter: ["filter", "where", "query", "conditions"],
	limit: ["limit", "per_page", "page_size", "pagesize", "count", "max_results", "top", "size"],
	offset: ["offset", "skip", "start", "from"],
	order: ["order", "order_by", "sort", "sort_by", "ordering"],
	searchMode: ["search_mode", "searchmode", "search_type", "mode"],
	page: ["page", "page_number", "pagenum", "p"],
	search: ["q", "search", "query_text", "term", "keyword", "text", "search_term", "searchterm"],
	select: ["select", "fields", "field", "include_fields", "projection", "only"],
}

function normalise(name: string): string {
	return (
		name
			/* A bracketed suffix is a *value* carried in the parameter name — `fields[articles]`,
			 * `filter[status]` — not part of the role's name. Matching the whole string against the
			 * alias list would fail to recognise the role at all, and the check that needed it would
			 * report itself inapplicable against an API that plainly supports it. */
			.replace(/\[[^\]]*\]$/, "")
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.toLowerCase()
			.replace(/[-\s]/g, "_")
	)
}

export function schemaOf(parameter: ParameterObject): SchemaObject {
	return parameter.schema ?? {}
}

/** The name of the first query parameter whose name is an alias of `role`. */
export function roleName(query: readonly ParameterObject[], role: Role): string | undefined {
	return query.find((p) => ALIASES[role].includes(normalise(p.name)))?.name
}

/** The first query parameter called `name`. */
export function parameterNamed(
	query: readonly ParameterObject[],
	name: string | undefined,
): ParameterObject | undefined {
	return query.find((p) => p.name === name)
}

export interface PagingRoles {
	limit?: string
	page?: string
	offset?: string
}

/**
 * `limit` and `page` are both bare integers, and several APIs spell one of them with a word that
 * belongs to the other's alias list — `count` most notoriously. The declared schema settles it:
 * a page size is the one with an upper bound, a page number the one that starts at 1.
 */
export function resolvePagingRoles(candidates: readonly ParameterObject[]): PagingRoles {
	const roles: PagingRoles = {}
	for (const parameter of candidates) {
		const type = schemaOf(parameter).type
		if (type !== "integer" && type !== "number") continue
		const role = namedRole(parameter, roles) ?? shapedRole(schemaOf(parameter), roles)
		if (role !== undefined) roles[role] = parameter.name
	}
	return roles
}

/** The free role this parameter's name claims. */
function namedRole(parameter: ParameterObject, roles: PagingRoles): keyof PagingRoles | undefined {
	const name = normalise(parameter.name)
	const schema = schemaOf(parameter)
	const hasMaximum = typeof schema.maximum === "number"
	/* `count` is a page size only when it reads like one; otherwise it is a total. */
	const sized = name !== "count" || hasMaximum || schema.default !== undefined
	if (roles.limit === undefined && ALIASES.limit.includes(name) && sized) return "limit"
	if (roles.page === undefined && ALIASES.page.includes(name) && !hasMaximum) return "page"
	if (roles.offset === undefined && ALIASES.offset.includes(name)) return "offset"
	return undefined
}

/** Unnamed but unmistakable: a bounded integer with a default is a page size, one starting at 1 a page. */
function shapedRole(schema: SchemaObject, roles: PagingRoles): keyof PagingRoles | undefined {
	const hasMaximum = typeof schema.maximum === "number"
	if (roles.limit === undefined && hasMaximum && schema.default !== undefined) return "limit"
	if (roles.page === undefined && schema.minimum === 1 && !hasMaximum) return "page"
	return undefined
}
