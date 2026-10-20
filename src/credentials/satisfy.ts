import type { Recipe } from "../config/types/security.ts"
import type { Requirement, ResolvedSecurity } from "../spec/security/requirements.ts"
import { recipeKind } from "./recipes/acquire.ts"

/*
 * Which of an operation's security alternatives one principal can send, decided offline from its
 * recipes alone, so plan and doctor can list what a config leaves unsatisfiable without a request.
 * Alternatives are tried in document order; each is an AND of its schemes. A requirement is met by a
 * recipe that names a kind and can carry the requirement's scopes: a login holds whatever the
 * document scopes, since the server decides; oauth2, and a mint whose body asks for `{scopes}`,
 * issue them; any other credential must `holds` every one.
 */

/** The alternative to send, or why none can be. `[]` is the anonymous alternative: send nothing. */
export type Satisfied = { alternative: Requirement[] } | { unsatisfied: string }

/** The principal's effective recipe for a scheme, or undefined when it has none. */
export type RecipesFor = (scheme: string) => Partial<Recipe> | undefined

/** The first alternative of `security` that `recipesFor` can satisfy, or the reasons none can. */
export function satisfy(security: Pick<ResolvedSecurity, "alternatives">, recipesFor: RecipesFor): Satisfied {
	const reasons = new Set<string>()
	for (const alternative of security.alternatives) {
		const missing = alternative.map((requirement) => missingFor(requirement, recipesFor)).find(Boolean)
		if (missing === undefined) return { alternative }
		reasons.add(missing)
	}
	return { unsatisfied: [...reasons].join("; ") }
}

/* Why one requirement is not met, or undefined when it is. */
function missingFor(requirement: Requirement, recipesFor: RecipesFor): string | undefined {
	const recipe = recipesFor(requirement.scheme)
	const kind = recipe === undefined ? undefined : recipeKind(recipe)
	if (recipe === undefined || kind === undefined) return `no credential for ${requirement.scheme}`
	if (kind === "login" || kind === "oauth2" || asksForScopes(recipe.mint?.body)) return undefined
	const held = new Set(recipe.holds ?? [])
	const lacking = requirement.scopes.filter((scope) => !held.has(scope))
	return lacking.length === 0 ? undefined : `no credential for ${requirement.scheme} holding ${lacking.join(", ")}`
}

/* Whether a mint body, anywhere inside it, leaves the scope set to the operation. */
function asksForScopes(body: unknown): boolean {
	if (typeof body === "string") return body.includes("{scopes}")
	if (Array.isArray(body)) return body.some(asksForScopes)
	if (body === null || typeof body !== "object") return false
	return Object.values(body).some(asksForScopes)
}
