import type { Recipe, RecipeKind } from "../../config/types/security.ts"
import { acquireHook } from "./hook.ts"
import { acquireLogin } from "./login.ts"
import { acquireMint } from "./mint.ts"
import { acquireOAuth2 } from "./oauth2.ts"
import { acquireStatic } from "./static.ts"
import type { AcquireCtx, Issued } from "./types.ts"

/** The kind a recipe names, or undefined when it names none. Validation makes it exactly one. */
export function recipeKind(recipe: Partial<Recipe>): RecipeKind | undefined {
	if (recipe.login !== undefined) return "login"
	if (recipe.mint !== undefined) return "mint"
	if (recipe.static !== undefined) return "static"
	if (recipe.hook !== undefined) return "hook"
	return recipe.oauth2 === undefined ? undefined : "oauth2"
}

/** Acquires a credential by the kind the effective recipe names. */
export function acquireRecipe(ctx: AcquireCtx, recipe: Partial<Recipe>): Promise<Issued> {
	if (recipe.login !== undefined) return acquireLogin(ctx, recipe.login, recipe)
	if (recipe.mint !== undefined) return acquireMint(ctx, recipe.mint, recipe)
	if (recipe.static !== undefined) return acquireStatic(ctx, recipe.static, recipe)
	if (recipe.hook !== undefined) return acquireHook(ctx, recipe)
	if (recipe.oauth2 !== undefined) return acquireOAuth2(ctx, recipe.oauth2, recipe)
	return Promise.reject(new Error(`the ${ctx.scheme.name} recipe names no kind (login, mint, static, hook or oauth2)`))
}
