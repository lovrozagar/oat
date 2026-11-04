/**
 * The last way teardown removes an account: `hooks.teardownPrincipal`, handed the account's own
 * credential as a request would send it now, renewed first, or marked `stale` with why when it
 * cannot be. Never another principal's credential, which would remove that account instead.
 */

import { effectiveRecipe } from "../../credentials/effective.ts"
import { recipeKind } from "../../credentials/recipes/acquire.ts"
import type { Credential, HeldCredential } from "../../credentials/store-types.ts"
import { messageOf } from "../../errors/message.ts"
import { accountLabel } from "../accounts/identity.ts"
import type { AccountEntry } from "../accounts/ledger.ts"
import type { RunContext } from "./context.ts"

type Verdict = { status: "removed" | "left"; note: string; principal?: string }

/*
 * Why these values `principal` sends are not its own account's, if they are not: one from a static
 * recipe is the configured principals' own, and one another principal holds too is that principal's.
 */
export async function borrowed(
	ctx: RunContext,
	principal: string,
	sent: ReadonlyArray<{ scheme: string; value: string }>,
): Promise<string | undefined> {
	const entry = ctx.store.principals[principal]
	for (const { scheme } of sent) {
		const recipe = effectiveRecipe(ctx.options.security?.[scheme], entry?.security?.[scheme])
		if (recipe !== undefined && recipeKind(recipe) === "static") {
			return `its ${scheme} credential comes from a static recipe, the configured principals' own`
		}
	}
	const values = new Set(sent.map((one) => one.value))
	const shared = (await ctx.store.snapshot()).find(
		(one) => one.principal !== principal && values.has(one.credential.value),
	)
	return shared === undefined ? undefined : `its credential is ${shared.principal}'s`
}

/*
 * The held credential as a request would send it now: teardown comes long after sign-up, when a
 * short-lived token has lapsed, so it is renewed first. One that cannot be renewed is handed as held,
 * with why, so a hook that then fails says the credential it was handed was stale.
 */
async function liveCredential(
	ctx: RunContext,
	held: HeldCredential,
): Promise<{ credential: Credential; renewal?: string }> {
	const { principal, scheme, scopes } = held
	const renewed = await ctx.store.acquire({ principal, scheme, scopes })
	return "blocked" in renewed ? { credential: held.credential, renewal: renewed.blocked } : { credential: renewed }
}

export async function hookRemoves(
	ctx: RunContext,
	entry: AccountEntry,
	principal: string | undefined,
	tried: string[],
): Promise<Verdict | undefined> {
	const teardown = ctx.hooks.teardownPrincipal
	if (teardown === undefined) return undefined
	const address = accountLabel(entry.identity)
	const held = (await ctx.store.snapshot()).find((one) => principal !== undefined && one.principal === principal)
	if (address === undefined || principal === undefined || held === undefined) {
		tried.push(
			`hooks.teardownPrincipal needs ${address === undefined ? "an address to name it by" : "a credential the run holds for it"}`,
		)
		return undefined
	}
	const { credential, renewal } = await liveCredential(ctx, held)
	/* A hook handed another principal's credential as this account's would remove that account. */
	const why = await borrowed(ctx, principal, [{ scheme: held.scheme, value: credential.value }])
	if (why !== undefined) {
		tried.push(`hooks.teardownPrincipal was not called: ${why}, and it is handed the account's own credential`)
		return undefined
	}
	try {
		await teardown(address, {
			credential: credential.value,
			sends: credential.sends,
			...(renewal === undefined ? {} : { stale: renewal }),
		})
		return { note: "removed by hooks.teardownPrincipal", principal, status: "removed" }
	} catch (error) {
		const stale =
			renewal === undefined ? "" : `, handed the credential it holds because renewing it was blocked: ${renewal}`
		tried.push(`hooks.teardownPrincipal threw: ${messageOf(error)}${stale}`)
		return undefined
	}
}
