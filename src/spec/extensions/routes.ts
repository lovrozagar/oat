/** `x-invalidate` and `x-cleanup`: tags that name other routes, read as `METHOD /path`. */

import { parseRouteRef } from "../routes.ts"
import type { OperationObject } from "../types.ts"
import { ext } from "./tag.ts"

/** `METHOD /path` as the route parser reads it, upper-cased and normalised; anything else trimmed as it is. */
function normaliseRouteRef(ref: string): string {
	const route = parseRouteRef(ref)
	return route === null ? ref.trim() : `${route.method} ${route.path}`
}

export function readInvalidate(op: OperationObject): string[] {
	const raw = ext(op, "x-invalidate")
	if (!Array.isArray(raw)) return []
	return raw.filter((r): r is string => typeof r === "string").map(normaliseRouteRef)
}

export function readCleanup(op: OperationObject): string | null {
	const value = ext(op, "x-cleanup")
	return typeof value === "string" ? normaliseRouteRef(value) : null
}
