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

/** Whether `role`'s alias list finds a parameter called `name`. */
export function isAliasOf(name: string, role: Role): boolean {
	return ALIASES[role].includes(normalize(name))
}

/**
 * The name of the first query parameter whose name is an alias of `role`. A search alias that
 * takes structured input is passed over: free text is the one thing a search check sends.
 */
function aliasName(query: readonly ParameterObject[], role: Role): string | undefined {
	return query.find((p) => isAliasOf(p.name, role) && (role !== "search" || !takesStructuredInput(p)))?.name
}

/** A parameter name per role, as `x-query.params` or config names them. */
export type NamedRoles = Partial<Record<Role, string>>

export interface ResolvedRoles {
	/** The parameter playing each role the operation has. */
	roles: Partial<Record<Role, string>>
	/** Names given for a role that the operation declares no parameter by. */
	unmatched: Array<{ role: Role; name: string }>
}

/* The roles matched by alias alone, in the order they claim parameters. */
const ALIASED = ["filter", "order", "select", "search", "searchMode", "cursor"] as const

/**
 * The parameter playing each role: the one a name points at when the operation declares it, else
 * the first alias of the role among the parameters no name has claimed. A name the author gave is
 * trusted as given; the guards the aliases need are for parameters nobody named.
 */
export function resolveRoles(query: readonly ParameterObject[], named: NamedRoles): ResolvedRoles {
	const roles: ResolvedRoles["roles"] = {}
	const unmatched: ResolvedRoles["unmatched"] = []
	for (const [role, name] of Object.entries(named) as Array<[Role, string]>) {
		if (query.some((p) => p.name === name)) roles[role] = name
		else unmatched.push({ name, role })
	}
	const claimed = new Set(Object.values(roles))
	const free = query.filter((p) => !claimed.has(p.name))
	for (const role of ALIASED) {
		/* A bare `mode` is too common to steal unless a search role is already present. */
		if (roles[role] !== undefined || (role === "searchMode" && roles.search === undefined)) continue
		const name = aliasName(free, role)
		if (name !== undefined) roles[role] = name
	}
	return { roles: { ...roles, ...resolvePagingRoles(free, roles) }, unmatched }
}

/** The first query parameter called `name`. */
export function parameterNamed(
	query: readonly ParameterObject[],
	name: string | undefined,
): ParameterObject | undefined {
	return query.find((p) => p.name === name)
}

interface PagingRoles {
	limit?: string
	page?: string
	offset?: string
}

/**
 * `limit` and `page` are both bare integers, and several APIs spell one of them with a word that
 * belongs to the other's alias list — `count` most notoriously. The declared schema settles it:
 * a page size is the one with an upper bound, a page number the one that starts at 1.
 */
function resolvePagingRoles(candidates: readonly ParameterObject[], named: NamedRoles): PagingRoles {
	const roles: PagingRoles = {}
	for (const role of ["limit", "page", "offset"] as const) {
		const name = named[role]
		if (name !== undefined) roles[role] = name
	}
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
