import type { SecurityScheme } from "../spec/security/schemes.ts"

/*
 * A recipe is for a scheme of the primary document, or for an origin's scheme that `origins[].security`
 * maps to a recipe name the primary does not declare. Such a recipe is acquired once, over the run's
 * store, by that origin scheme; the first origin in config order that maps it names the scheme.
 */

/** An origin as recipes read it: its `origins[].security` mapping, raw, and its document's schemes. */
export interface OriginSchemes {
	mapping: unknown
	schemes: ReadonlyMap<string, SecurityScheme>
}

/** Each origin scheme a mapping names, to the recipe name it maps to. */
export function mappedPairs(origin: OriginSchemes): Array<[scheme: string, recipe: string]> {
	const { mapping, schemes } = origin
	if (typeof mapping !== "object" || mapping === null) return []
	return Object.entries(mapping).filter(
		(pair): pair is [string, string] => typeof pair[1] === "string" && schemes.has(pair[0]),
	)
}

/** The scheme each recipe name is for: the primary's own, then each origin-only recipe's origin scheme. */
export function recipeSchemes(
	primary: ReadonlyMap<string, SecurityScheme>,
	origins: Iterable<OriginSchemes>,
): ReadonlyMap<string, SecurityScheme> {
	const schemes = new Map(primary)
	for (const origin of origins) {
		for (const [scheme, recipe] of mappedPairs(origin)) {
			if (!schemes.has(recipe)) schemes.set(recipe, origin.schemes.get(scheme) as SecurityScheme)
		}
	}
	return schemes
}

/** The recipe names only an origin's scheme is for: their format and placements are that scheme's own. */
export function originOnlyRecipes(
	primary: ReadonlyMap<string, SecurityScheme>,
	origins: Iterable<OriginSchemes>,
): ReadonlySet<string> {
	return new Set([...recipeSchemes(primary, origins).keys()].filter((name) => !primary.has(name)))
}
