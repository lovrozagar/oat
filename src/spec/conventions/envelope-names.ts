/** The response fields `x-query.envelope` or config `query.envelope` read each paging fact from. */

import type { QueryEnvelopeNames, QueryEnvelopeRole } from "../../config/types/query.ts"

/** The role names an `envelope` object may hold, in the order a message lists them. */
export const QUERY_ENVELOPE_ROLES: readonly QueryEnvelopeRole[] = ["total", "hasMore", "nextCursor"]

export function isQueryEnvelopeRole(key: string): key is QueryEnvelopeRole {
	return (QUERY_ENVELOPE_ROLES as readonly string[]).includes(key)
}

/**
 * The known roles of a raw `envelope` object that name a field. `x-query`'s validation records a gap
 * for everything else; this keeps what can be used.
 */
export function readEnvelopeNames(raw: unknown): QueryEnvelopeNames | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
	return Object.fromEntries(
		Object.entries(raw).filter(([role, name]) => isQueryEnvelopeRole(role) && typeof name === "string" && name !== ""),
	) as QueryEnvelopeNames
}

/**
 * The names a list response uses: its `x-query.envelope`, with config's laid over them. A config name
 * the response's envelope does not hold is not applied to it; config is run-wide, and the response
 * it was written for holds it.
 */
export function mergeEnvelopeNames(sources: {
	tag: unknown
	config?: QueryEnvelopeNames | undefined
	declared: readonly string[]
}): QueryEnvelopeNames {
	const applied = Object.entries(sources.config ?? {}).filter(([, name]) => sources.declared.includes(name))
	return { ...readEnvelopeNames(sources.tag), ...Object.fromEntries(applied) }
}
