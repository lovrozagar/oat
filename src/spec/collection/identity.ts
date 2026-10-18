/** The property that identifies an instance of an entity. */

import type { SchemaObject } from "../types.ts"
import { effective } from "./effective.ts"

const IDENTITY_CANDIDATES = ["id", "uuid", "slug", "key", "name"]

/** `{table_id}` or `{tableId}` on `/tables/…` implies the item's own key is `id`; `undefined` otherwise. */
function hintedKey(pathParamHint: string | undefined): string | undefined {
	if (pathParamHint === undefined) return undefined
	const implied = pathParamHint
		.replace(/^.*[_.-]/, "")
		.replace(/^[a-z0-9]+(?=[A-Z])/, "")
		.toLowerCase()
	return IDENTITY_CANDIDATES.includes(implied) ? implied : undefined
}

/** A required identity-like property, else any identity-like property the schema has. */
function identityProperty(itemSchema: SchemaObject, names: string[]): string | undefined {
	const required = Array.isArray(itemSchema.required) ? (itemSchema.required as string[]) : []
	return (
		IDENTITY_CANDIDATES.find((candidate) => required.includes(candidate)) ??
		IDENTITY_CANDIDATES.find((candidate) => names.includes(candidate))
	)
}

/**
 * Finds the property that identifies an instance: the one the item route's own parameter names
 * when the schema has it (`{noteId}` → `id`), then a required identity-like property, then any
 * identity-like property, then the parameter's implied name. The route comes first because
 * teardown deletes through it: a `name` that is merely required would put a display value in the
 * delete path, whose 404 counts as removed while the real record stays behind.
 */
export function deriveIdentity(
	raw: SchemaObject | null,
	pathParamHint?: string,
	/** The route ends in that parameter, so it names this item rather than a parent. */
	itemRoute = true,
): string | null {
	const hinted = hintedKey(pathParamHint)
	const itemSchema = effective(raw)
	const props = itemSchema?.properties
	if (itemSchema !== null && props !== null && typeof props === "object") {
		const names = Object.keys(props as Record<string, unknown>)
		if (itemRoute && hinted !== undefined && names.includes(hinted)) return hinted
		const found = identityProperty(itemSchema, names)
		if (found !== undefined) return found
	}
	return hinted ?? null
}
