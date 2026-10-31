/** The query parameter names `x-query.params` or config `query.params` give each role. */

import type { QueryParamNames, QueryParamRole } from "../../config/types/query.ts"
import type { NamedRoles, Role } from "./roles.ts"

/** The role each public name stands for; the public vocabulary says `sort`, the conventions `order`. */
export const ROLE_OF: Readonly<Record<QueryParamRole, Role>> = {
	filter: "filter",
	sort: "order",
	select: "select",
	search: "search",
	searchMode: "searchMode",
	limit: "limit",
	page: "page",
	offset: "offset",
	cursor: "cursor",
}

/** The role names a `params` object may hold, for the message that lists them. */
export const QUERY_PARAM_ROLES = /* @__PURE__ */ Object.keys(ROLE_OF) as QueryParamRole[]

export function isQueryParamRole(key: string): key is QueryParamRole {
	return Object.hasOwn(ROLE_OF, key)
}

/** The public name of a role, as a message to the author says it. */
export function publicRole(role: Role): QueryParamRole {
	return role === "order" ? "sort" : role
}

/**
 * The known roles of a raw `params` object that name a parameter. `x-query`'s validation records a
 * gap for everything else; this keeps what can be used.
 */
export function readQueryParams(raw: unknown): QueryParamNames | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
	return Object.fromEntries(
		Object.entries(raw).filter(([role, name]) => isQueryParamRole(role) && typeof name === "string" && name !== ""),
	) as QueryParamNames
}

export function toNamedRoles(params: QueryParamNames): NamedRoles {
	return Object.fromEntries(
		Object.entries(params).map(([role, name]) => [ROLE_OF[role as QueryParamRole], name]),
	) as NamedRoles
}

/**
 * The names an operation uses: its `x-query.params`, with config's laid over them. A config name the
 * operation does not declare is not applied to it; config is run-wide, and the operation it was
 * written for declares it.
 */
export function mergeQueryParams(sources: {
	tag: unknown
	config?: QueryParamNames | undefined
	declared: readonly string[]
}): QueryParamNames {
	const applied = Object.entries(sources.config ?? {}).filter(([, name]) => sources.declared.includes(name))
	return { ...readQueryParams(sources.tag), ...Object.fromEntries(applied) }
}
