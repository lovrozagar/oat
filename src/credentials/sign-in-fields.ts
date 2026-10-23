import type { Recipe } from "../config/types/security.ts"
import type { AuthStep } from "../config/types/steps.ts"
import { principalKeysIn } from "./interpolate.ts"

/*
 * What a principal signs in with, by name: each identity key a recipe's sign-in reads as
 * `{principal.<key>}` (its login and refresh steps, an out-of-band address, a mint's body, an oauth2
 * grant), and the field each is sent under. A write that changes one of those on the principal's
 * own record changes how it signs in. A static or hooked recipe reads no identity key here.
 */

/** The identity keys `recipe` signs in with, and the request fields that carry them. */
export function signInFields(recipe: Partial<Recipe>): Set<string> {
	const steps = [...(recipe.login?.steps ?? []), ...(recipe.refresh?.steps ?? [])]
	const found = new Set<string>()
	walk([steps.map(readBy), recipe.mint?.body, recipe.oauth2], undefined, found)
	return found
}

/* Everything a step reads an identity key into: what it sends, binds, or is mailed at. */
function readBy(step: AuthStep): unknown {
	if ("outOfBand" in step) return step.outOfBand.address
	return [step.bind, step.body, step.headers, step.query, "path" in step ? step.path : null]
}

function walk(value: unknown, field: string | undefined, found: Set<string>): void {
	if (typeof value === "string") {
		const keys = principalKeysIn(value)
		for (const key of keys) found.add(key)
		if (keys.length > 0 && field !== undefined) found.add(field)
	} else if (Array.isArray(value)) for (const item of value) walk(item, undefined, found)
	else if (value !== null && typeof value === "object")
		for (const [key, item] of Object.entries(value)) walk(item, key, found)
}
