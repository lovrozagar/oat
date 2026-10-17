import type { Recipe, RecipeKind } from "../config/types/security.ts"

/*
 * The recipe one principal uses for one scheme. An override that names a kind replaces the base's
 * kind, keeping the base's options; an override that names none merges its options over the base.
 * Validation and the credential resolver both read recipes through this, so they cannot disagree.
 */

const KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set<RecipeKind>(["login", "mint", "static", "hook", "oauth2"])

export function effectiveRecipe(
	base: Partial<Recipe> | undefined,
	override: Partial<Recipe> | undefined,
): Partial<Recipe> | undefined {
	if (override === undefined) return base
	if (base === undefined) return override
	const namesKind = Object.keys(override).some((key) => KINDS.has(key) && override[key as RecipeKind] !== undefined)
	if (!namesKind) return { ...base, ...override } as Partial<Recipe>
	const options = Object.fromEntries(Object.entries(base).filter(([key]) => !KINDS.has(key)))
	return { ...options, ...override } as Partial<Recipe>
}
