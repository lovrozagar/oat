/*
 * A credential for a probe alone: a second login, a fresh mint, a new token grant. It is held under a
 * probe principal the store enrolls with the owner's identity, `<owner>#probe-<n>`, so revoking or
 * rotating it never touches the owner's own session. A mint is made with the owner's own `with`
 * session, which outlives it; any other recipe signs the probe principal in. Static and hook recipes
 * hold one value, so they cannot issue a second.
 */

import type { PrincipalEntry } from "../config/types/security.ts"
import { probePrincipal } from "./probe-principal.ts"
import { acquireRecipe, recipeKind } from "./recipes/acquire.ts"
import type { Issued } from "./recipes/types.ts"
import { signsUp } from "./signup.ts"
import {
	acquireCtx,
	blockedBy,
	type Entry,
	type Plan,
	planOf,
	record,
	registerRevoke,
	type StoreCtx,
} from "./store-plan.ts"
import { own } from "./effective.ts"
import type { Blocked, CredentialKey, DedicatedHeld, DedicatedUse, Rotated } from "./store-types.ts"

/**
 * A dedicated credential of `key.principal`'s for `key.scheme`, or why there can be none: a new one
 * each time, unless the probe never spends it, when the run's first for that scope set serves again.
 */
export function acquireDedicated(
	ctx: StoreCtx,
	key: CredentialKey,
	use: DedicatedUse = {},
): Promise<DedicatedHeld | Blocked> {
	if (use.reusable !== true) return issueDedicated(ctx, key)
	const id = [key.principal, key.scheme, ...(key.scopes ?? []).toSorted()].join("\u0000")
	let held = ctx.shared.get(id)
	if (held === undefined) {
		held = issueDedicated(ctx, key)
		ctx.shared.set(id, held)
	}
	return held
}

/* A new dedicated credential under a probe principal of its own. */
async function issueDedicated(ctx: StoreCtx, key: CredentialKey): Promise<DedicatedHeld | Blocked> {
	const owner = planOf(ctx, key)
	if ("blocked" in owner) return owner
	const refused = await refusal(ctx, owner)
	if (refused !== undefined) return refused
	const plan = planOf(ctx, { ...key, principal: enroll(ctx, owner.principal) }) as Plan
	const kind = recipeKind(plan.recipe) as string
	const issuing = acquireCtx(ctx, kind === "mint" ? owner : plan)
	let entry: Entry
	try {
		entry = record(ctx, plan, await acquireRecipe(issuing, plan.recipe))
	} catch (error) {
		return { blocked: blockedBy(kind, owner, error) }
	}
	ctx.entries.set(plan.id, Promise.resolve(entry))
	return heldOf(ctx, { entry, owner, plan })
}

/* Why the owner's recipe cannot issue a second credential: its kind, a signup, or the owner BLOCKED. */
async function refusal(ctx: StoreCtx, owner: Plan): Promise<Blocked | undefined> {
	const kind = recipeKind(owner.recipe)
	if (kind === "static" || kind === "hook") return { blocked: `${kind} recipes cannot issue a dedicated credential` }
	if (signsUp(owner.recipe, ctx.options.signup)) {
		return { blocked: `a second login for ${owner.principal}/${owner.scheme} would sign it up again` }
	}
	const settled = await ctx.entries.get(owner.id)
	return settled !== undefined && "blocked" in settled ? settled : undefined
}

/* Enrolls the next probe principal of `owner`, with the owner's identity and recipes and what its login bound. */
function enroll(ctx: StoreCtx, owner: string): string {
	ctx.probes += 1
	const principal = probePrincipal(owner, ctx.probes)
	ctx.dedicated.add(principal)
	const { created: _created, fresh: _fresh, ...entry } = own(ctx.principals, owner) as PrincipalEntry
	ctx.principals[principal] = entry
	ctx.bound.set(principal, { ...ctx.bound.get(owner) })
	return principal
}

interface Holding {
	entry: Entry
	owner: Plan
	plan: Plan
}

function heldOf(ctx: StoreCtx, { entry, owner, plan }: Holding): DedicatedHeld {
	const held: DedicatedHeld = {
		credential: entry.credential,
		owner: owner.principal,
		principal: plan.principal,
		scheme: plan.scheme,
	}
	const { revokeKey } = entry
	if (revokeKey !== undefined) held.revoke = () => revokeNow(ctx, revokeKey)
	if (entry.issued.refresh !== undefined) held.rotate = () => rotate(ctx, plan, entry)
	return held
}

/* Revokes it now, once: teardown then has nothing left to revoke. A failure stays for teardown. */
async function revokeNow(ctx: StoreCtx, key: string): Promise<void> {
	const revoking = ctx.revokes.get(key)
	if (revoking === undefined) return
	await revoking.revoke()
	ctx.revokes.delete(key)
}

/* The refresh that rotated it, kept so a replay runs it again from before the rotation. */
async function rotate(ctx: StoreCtx, plan: Plan, before: Entry): Promise<Rotated> {
	const refresh = before.issued.refresh as NonNullable<Issued["refresh"]>
	const after = record(ctx, plan, await refresh())
	ctx.entries.set(plan.id, Promise.resolve(after))
	return { credential: after.credential, replay: () => replay(ctx, plan, refresh) }
}

/* Rejects when the reuse is refused. An accepted one opened a session: teardown revokes it too. */
async function replay(ctx: StoreCtx, plan: Plan, refresh: NonNullable<Issued["refresh"]>): Promise<void> {
	/* The spent refresh token, sent again: meant to be refused, so a probe. */
	const { revoke } = await refresh({ probe: true })
	if (revoke !== undefined) registerRevoke(ctx, plan, { key: `${plan.id}\u0000replay ${ctx.registered}`, revoke })
}
