import type { Recipe } from "../../config/types/security.ts"
import { expiresAtOf } from "../expiry.ts"
import { assertHolds } from "./answer.ts"
import type { AcquireCtx, Issued } from "./types.ts"

/**
 * The value `hooks.resolveCredential(scheme, principal)` returns, asked afresh on every acquire so a
 * TOTP code or a vault lease is current. Its own `expiresIn` wins over the recipe's. It serves a scoped
 * operation only for the scopes the recipe `holds`.
 */
export async function acquireHook(ctx: AcquireCtx, options: Partial<Recipe>): Promise<Issued> {
	const hook = ctx.ports.resolveCredential
	if (hook === undefined) {
		throw new Error(`the ${ctx.scheme.name} recipe is \`hook: true\`, but the config sets no hooks.resolveCredential`)
	}
	assertHolds(ctx, options.holds)
	const answer = await hook(ctx.scheme.name, ctx.principal)
	if (answer === null) {
		throw new Error(
			`hooks.resolveCredential gave no credential for "${ctx.principal.id}" on scheme "${ctx.scheme.name}"`,
		)
	}
	const { value, expiresIn = options.expiresIn } = typeof answer === "string" ? { value: answer } : answer
	return { expiresAt: expiresAtOf({ body: undefined, expiresIn, now: ctx.now(), value }), value }
}
