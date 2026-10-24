/** Which query parameter plays which role, by the aliases real APIs use and the schema they declare. */

import type { ParameterObject, JsonSchema } from "../types.ts"
import { scalarKinds } from "../schema.ts"

export type Role = "filter" | "order" | "select" | "search" | "searchMode" | "limit" | "page" | "offset" | "cursor"

/*
 * Aliases seen across real APIs. Order matters only for readability; a parameter is matched
 * case-insensitively and with separators normalized, so `perPage`, `per_page` and `PerPage` are
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

function normalize(name: string): string {
	return (
		name
			/* A bracketed suffix is a *value* carried in the parameter name — `fields[articles]`,
			 * `filter[status]` — not part of the role's name. Matching the whole string against the
			 * alias list would fail to recognize the role at all, and the check that needed it would
			 * report itself inapplicable against an API that plainly supports it. */
			.replace(/\[[^\]]*\]$/, "")
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.toLowerCase()
			.replace(/[-\s]/g, "_")
	)
}

export function schemaOf(parameter: ParameterObject): JsonSchema {
	return parameter.schema ?? {}
}

/** What the document shows of a parameter's values: its examples, then its description. */
export function demonstrated(parameter: ParameterObject): string {
	const schema = schemaOf(parameter)
	return [
		...(Array.isArray(schema.examples) ? schema.examples : []),
		...(schema.example === undefined ? [] : [schema.example]),
		...(typeof parameter.description === "string" ? [parameter.description] : []),
	]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
}

/* `key:value`, `key1:value2`, `key: value` — the spelling a document uses to say it takes pairs. */
const KEY_VALUE = /\bkey\w*\s*:\s*value\w*/i

/**
 * Whether a parameter's own declaration says it takes structured input rather than free text: a
 * scalar that is not a string, a `pattern` with a `:` in it, or examples or a description that spell
 * out `key:value`. Keycloak names its attribute query `q` and describes it as
 * `'key1:value2 key2:value2'`; a search probe sent there tests a grammar nobody wrote, and an empty
 * answer to it reads as a backend whose search is broken. Kept this narrow on purpose: a colon in
 * an example (`role:admin`) or the word "attribute" alone can belong to free text.
 */
function takesStructuredInput(parameter: ParameterObject): boolean {
	const schema = schemaOf(parameter)
	const kinds = scalarKinds(schema)
	if (kinds !== undefined && !kinds.includes("string")) return true
	if (typeof schema.pattern === "string" && schema.pattern.includes(":")) return true
	return KEY_VALUE.test(demonstrated(parameter))
}

/**
 * The name of the first query parameter whose name is an alias of `role`. A search alias that
 * takes structured input is passed over: free text is the one thing a search check sends.
 */
export function roleName(query: readonly ParameterObject[], role: Role): string | undefined {
	return query.find((p) => ALIASES[role].includes(normalize(p.name)) && (role !== "search" || !takesStructuredInput(p)))
		?.name
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
		/* A page size or number is a number, however its nullability is spelled. */
		const kinds = scalarKinds(schemaOf(parameter))
		if (kinds === undefined || !kinds.every((kind) => kind === "integer" || kind === "number")) continue
		const role = namedRole(parameter, roles) ?? shapedRole(schemaOf(parameter), roles)
		if (role !== undefined) roles[role] = parameter.name
	}
	return roles
}

/** The free role this parameter's name claims. */
function namedRole(parameter: ParameterObject, roles: PagingRoles): keyof PagingRoles | undefined {
	const name = normalize(parameter.name)
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
function shapedRole(schema: JsonSchema, roles: PagingRoles): keyof PagingRoles | undefined {
	const hasMaximum = typeof schema.maximum === "number"
	if (roles.limit === undefined && hasMaximum && schema.default !== undefined) return "limit"
	if (roles.page === undefined && schema.minimum === 1 && !hasMaximum) return "page"
	return undefined
}
