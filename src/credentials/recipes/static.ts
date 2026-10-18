import type { Recipe, StaticRecipe } from "../../config/types/security.ts"
import { expiresAtOf } from "../expiry.ts"
import { fillPrincipal } from "../interpolate.ts"
import { assertHolds } from "./answer.ts"
import type { AcquireCtx, Issued } from "./types.ts"

/**
 * A value fixed in config. A basic pair is `user:pass`, which the basic placement base64-encodes.
 * It serves a scoped operation only for the scopes it `holds`.
 */
export async function acquireStatic(ctx: AcquireCtx, fixed: StaticRecipe, options: Partial<Recipe>): Promise<Issued> {
	assertHolds(ctx, options.holds)
	const filled = fillPrincipal(ctx.principal, fixed)
	const value = typeof filled === "string" ? filled : `${filled.username}:${filled.password}`
	return { expiresAt: expiresAtOf({ body: undefined, expiresIn: options.expiresIn, now: ctx.now(), value }), value }
}
