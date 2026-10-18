/** `x-invalidate` and `x-cleanup`: tags that name other routes, read as `METHOD /path`. */

import { normalisePath } from "../routes.ts"
import type { OperationObject } from "../types.ts"
import { ext } from "./tag.ts"

/** `method /path` with the method upper-cased and the path normalised; anything else trimmed as it is. */
function normaliseRouteRef(ref: string): string {
	const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(ref)
	if (match === null) return ref.trim()
	/* Both groups are required by the pattern. */
	return `${(match[1] as string).toUpperCase()} ${normalisePath(match[2] as string)}`
}

export function readInvalidate(op: OperationObject): string[] {
	const raw = ext<unknown>(op, "x-invalidate")
	if (!Array.isArray(raw)) return []
	return raw.filter((r): r is string => typeof r === "string").map(normaliseRouteRef)
}

export function readCleanup(op: OperationObject): string | null {
	const value = ext<unknown>(op, "x-cleanup")
	return typeof value === "string" ? normaliseRouteRef(value) : null
}
