import { messageOf } from "../errors/message.ts"
import { expiresAtOf } from "./expiry.ts"
import { own } from "./effective.ts"
import { acquireDedicated } from "./dedicated.ts"
import { acquireRecipe, recipeKind } from "./recipes/acquire.ts"
import { RefusedAnswer } from "./recipes/answer.ts"
import { heldLogin } from "./recipes/login.ts"
import type { Issued } from "./recipes/types.ts"
import { isStale } from "./refresh.ts"
import { signsUp } from "./signup.ts"
import {
	acquireCtx,
	blockedBy,
	type Entry,
	identityOf,
	pairOf,
	type Plan,
	planOf,
	record,
	type Settled,
	type StoreCtx,
	storeCtx,
} from "./store-plan.ts"
import type {
	Adopting,
	Blocked,
	CredentialKey,
	CredentialStore,
	Held,
	HeldCredential,
	RevokeFailure,
	StoreOptions,
} from "./store-types.ts"

/*
 * The credentials one run holds, keyed principal × scheme × scope set. A store is created per run
 * and holds no module state. Every acquire for a key shares one pending issue, so concurrent first
 * callers share one login.
 *
 * A login session is per principal × scheme: it holds whatever scopes the document asks, since the
 * server decides, so its key carries no scope set and one login serves them all. A mint or an oauth2
 * grant is issued for the scopes asked, so each scope set is its own credential.
 *
 * Nothing is retried. A failed acquire is memoized as BLOCKED with its reason, so a login is
 * attempted once per principal and scheme per run. A failed declared refresh falls back to one login
 * (never a signup); a failed renewal blocks the principal × scheme, and other principals carry on. A
 * refresh names the value the refused request carried: when the store already holds a newer one,
 * that is the answer, and nothing is renewed.
 *
 * A static credential has nothing to renew: on a 401 its recipe gives the same value again, the one
 * retry gets the same 401, and that refusal is the finding. The no-op is deliberate.
 */

export type {
	Adopting,
	Blocked,
	Credential,
	CredentialKey,
	CredentialStore,
	DedicatedHeld,
	Held,
	HeldCredential,
	RevokeFailure,
	Rotated,
	StoreOptions,
} from "./store-types.ts"

/** A credential store for one run. */
export function createStore(options: StoreOptions): CredentialStore {
	const ctx = storeCtx(options)
	return {
		acquire: (key) => acquire(ctx, key),
		acquireDedicated: (key, use) => acquireDedicated(ctx, key, use),
		adopt: (input) => adopt(ctx, input),
		block: (key, reason) => {
			ctx.blocked.set(pairOf(key), { blocked: reason })
		},
		enroll: (id, entry) => {
			ctx.principals[id] = entry
		},
		identityOf: (principal) => identityOf(ctx, principal),
		principals: ctx.principals,
		refresh: (request) => refresh(ctx, request),
		revokeAll: () => revokeAll(ctx),
		revokeSessions: (of) => revokeSessions(ctx, of),
		snapshot: () => snapshot(ctx),
	}
}

async function acquire(ctx: StoreCtx, key: CredentialKey): Promise<Held> {
	const plan = planOf(ctx, key)
	if ("blocked" in plan) return plan
	let pending = ctx.entries.get(plan.id)
	if (pending === undefined) {
		pending = issue(ctx, plan)
		ctx.entries.set(plan.id, pending)
	}
	const held = await pending
	if ("blocked" in held) return held
	const fresh = { expiresAt: held.credential.expiresAt, issuedAt: held.issuedAt }
	if (!isStale(fresh, { bufferMs: ctx.bufferMs, now: ctx.now() })) return held.credential
	return renewEntry(ctx, plan, held)
}

async function refresh(ctx: StoreCtx, request: CredentialKey & { sentValue: string }): Promise<Held> {
	const plan = planOf(ctx, request)
	if ("blocked" in plan) return plan
	const pending = ctx.entries.get(plan.id)
	if (pending === undefined) return acquire(ctx, request)
	const held = await pending
	if ("blocked" in held) return held
	if (held.credential.value !== request.sentValue || held.renewedFrom === request.sentValue) return held.credential
	return renewEntry(ctx, plan, held)
}

async function renewEntry(ctx: StoreCtx, plan: Plan, held: Entry): Promise<Held> {
	const renewed = await ctx.renew(held, () => {
		const from = held.credential.value
		const next = renewal(ctx, plan, held).then((settled) =>
			"blocked" in settled ? settled : { ...settled, renewedFrom: from },
		)
		ctx.entries.set(plan.id, next)
		return next
	})
	return "blocked" in renewed ? renewed : renewed.credential
}

/*
 * A credential with no refresh of its own is renewed by acquiring afresh through its recipe, unless
 * that would register the account again (its login calls the signup, or the principal is one the run
 * `created` by its login): then it fails closed, never registering a second account.
 */
async function renewal(ctx: StoreCtx, plan: Plan, held: Entry): Promise<Settled> {
	const created = recipeKind(plan.recipe) === "login" && own(ctx.principals, plan.principal)?.created === true
	const signup = created || signsUp(plan.recipe, ctx.options.signup)
	if (held.issued.refresh === undefined && signup) {
		return blockPair(ctx, plan, `renewing ${plan.principal}/${plan.scheme} would sign up again; declare a refresh`)
	}
	try {
		const renew = held.issued.refresh ?? (() => acquireRecipe(acquireCtx(ctx, plan), plan.recipe))
		return record(ctx, plan, await renew())
	} catch (error) {
		if (held.issued.refresh === undefined || signup) return blockPair(ctx, plan, blockedBy("refresh", plan, error))
		/* A refused declared refresh falls back to one fresh login, shared by concurrent callers; only its failure blocks. */
		const settled = await issue(ctx, plan, { refused: error })
		return "blocked" in settled ? blockPair(ctx, plan, settled.blocked) : settled
	}
}

/* A renewal that failed blocks the principal × scheme for every scope set, for the rest of the run. */
function blockPair(ctx: StoreCtx, plan: Plan, reason: string): Blocked {
	const blocked = { blocked: reason }
	ctx.blocked.set(plan.pair, blocked)
	return blocked
}

/* A credential through the recipe; as a refused refresh's fallback, a failure names the renewal. */
async function issue(ctx: StoreCtx, plan: Plan, after?: { refused: unknown }): Promise<Settled> {
	try {
		return record(ctx, plan, await acquireRecipe(acquireCtx(ctx, plan), plan.recipe))
	} catch (error) {
		if (after === undefined) return { blocked: blockedBy(recipeKind(plan.recipe) ?? "acquire", plan, error) }
		const why = `the refresh failed (${messageOf(after.refused)}), then acquiring afresh failed (${messageOf(error)})`
		return { blocked: blockedBy("renewal", plan, new Error(why)) }
	}
}

/*
 * Taken in as a login's would be: an adopted value renews by the principal's own recipe. An empty
 * value is no credential, so what is held stays.
 */
async function adopt(ctx: StoreCtx, input: Adopting): Promise<Held> {
	const plan = planOf(ctx, { principal: input.principal, scheme: input.scheme }, { adopting: true })
	if ("blocked" in plan) return plan
	const { value } = input
	if (value === "") return { blocked: blockedBy("adopt", plan, new Error("an empty value is no credential")) }
	const replaced = await ctx.entries.get(plan.id)
	const session = replaced === undefined || "blocked" in replaced ? {} : { replaced: replaced.issued.refresh }
	let entry: Entry
	try {
		entry = record(ctx, plan, heldIssue(ctx, plan, { scope: input.scope ?? {}, value, ...session }))
	} catch (error) {
		return { blocked: blockedBy("adopt", plan, error) }
	}
	ctx.blocked.delete(plan.pair)
	ctx.entries.set(plan.id, Promise.resolve(entry))
	return entry.credential
}

/* An adopted login value renews by the recipe's declared refresh; any other is acquired afresh. */
function heldIssue(
	ctx: StoreCtx,
	plan: Plan,
	held: { value: string; scope: Readonly<Record<string, string>>; replaced?: Issued["refresh"] },
): Issued {
	if (recipeKind(plan.recipe) === "login") return heldLogin(acquireCtx(ctx, plan), held, plan.recipe)
	const { value } = held
	return { expiresAt: expiresAtOf({ body: undefined, expiresIn: plan.recipe.expiresIn, now: ctx.now(), value }), value }
}

async function snapshot(ctx: StoreCtx): Promise<HeldCredential[]> {
	const settled = await Promise.all(ctx.entries.values())
	return settled.flatMap((held) => ("blocked" in held ? [] : [held.key]))
}

/*
 * Each principal's own login session, ended by its declared revoke, one at a time: the run's last
 * call. A dedicated session is revokeAll's, and a mint or a grant has no session to end.
 */
async function revokeSessions(ctx: StoreCtx, of: (principal: string) => boolean): Promise<RevokeFailure[]> {
	const failures: RevokeFailure[] = []
	for (const held of await Promise.all(ctx.entries.values())) {
		if ("blocked" in held || held.issued.revoke === undefined) continue
		const { principal, scheme } = held.key
		const plan = planOf(ctx, { principal, scheme })
		if (ctx.dedicated.has(principal) || !of(principal) || "blocked" in plan || recipeKind(plan.recipe) !== "login")
			continue
		try {
			await held.issued.revoke()
		} catch (error) {
			failures.push({ principal, reason: messageOf(error), scheme })
		}
	}
	return failures
}

/*
 * One at a time, so a teardown's revokes reach the backend in the order they were minted. A minted
 * key whose record an accepted DELETE already removed is not revoked again, and one whose revoke a
 * 4xx refused is no failure when a read of its record shows it gone.
 */
async function revokeAll(ctx: StoreCtx): Promise<RevokeFailure[]> {
	const { records } = ctx.options.ports
	const failures: RevokeFailure[] = []
	const revoking = [...ctx.revokes.values()]
	ctx.revokes.clear()
	for (const { principal, record: minted, revoke, scheme } of revoking) {
		if (minted !== undefined && records.removed(minted)) continue
		try {
			await revoke()
		} catch (error) {
			if (minted !== undefined && refusedByClient(error) && (await records.gone(minted))) continue
			failures.push({ principal, reason: messageOf(error), scheme })
		}
	}
	return failures
}

function refusedByClient(error: unknown): boolean {
	return error instanceof RefusedAnswer && error.status >= 400 && error.status < 500
}
