import type { Recipe, RecipeKind } from "../config/types/security.ts"

/*
 * The recipe one principal uses for one scheme. An override that names a kind replaces the base's
 * kind, keeping only the options that belong to the scheme (`format`, `placements`): `refresh`,
 * `expiresIn` and `holds` describe the replaced kind's credential. An override that names no kind
 * merges its options over the base.
 * Validation and the credential resolver both read recipes through this, so they cannot disagree.
 */

const KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set<RecipeKind>(["login", "mint", "static", "hook", "oauth2"])
const SCHEME_OPTIONS: ReadonlySet<string> = /* @__PURE__ */ new Set(["format", "placements"])

export function effectiveRecipe(
	base: Partial<Recipe> | undefined,
	override: Partial<Recipe> | undefined,
): Partial<Recipe> | undefined {
	if (override === undefined) return base
	if (base === undefined) return override
	const namesKind = Object.keys(override).some((key) => KINDS.has(key) && override[key as RecipeKind] !== undefined)
	if (!namesKind) return { ...base, ...override } as Partial<Recipe>
	const options = Object.fromEntries(Object.entries(base).filter(([key]) => SCHEME_OPTIONS.has(key)))
	return { ...options, ...override } as Partial<Recipe>
}

/** A config map's own entry: a principal or scheme named `constructor` is not the prototype's. */
export function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(map, key) ? map[key] : undefined
}
