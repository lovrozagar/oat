import type { OpenApiDocument } from "../types.ts"

/** Where recursive schemas live after dereferencing: `$ref: "oat-defs#/$defs/<name>"`. */
export const DEFS_ID = "oat-defs"
export const DEFS_KEY = "x-oat-defs"

/** The recursive schemas a dereferenced document refers to, by name. Empty when there are none. */
export function documentDefs(doc: OpenApiDocument): Record<string, Record<string, unknown>> {
	const defs = (doc as Record<string, unknown>)[DEFS_KEY]
	return defs !== null && typeof defs === "object" ? (defs as Record<string, Record<string, unknown>>) : {}
}
