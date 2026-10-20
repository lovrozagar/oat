import type { PrincipalsConfig, Recipe } from "../config/types/security.ts"
import { messageOf } from "../errors/message.ts"
import type { SecurityScheme } from "../spec/security/schemes.ts"
import { effectiveRecipe } from "./effective.ts"
import { expiresAtOf } from "./expiry.ts"
import { sendsFor } from "./placement.ts"
import { acquireRecipe, recipeKind } from "./recipes/acquire.ts"
import { heldLogin } from "./recipes/login.ts"
import type { AcquireCtx, Issued } from "./recipes/types.ts"
import { createRenewals, DEFAULT_REFRESH_BUFFER_MS, isStale } from "./refresh.ts"
import { signsUp } from "./signup.ts"
import type {
	Blocked,
	Credential,
	CredentialKey,
	CredentialStore,
	Held,
	Adopting,
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
 * (never a signup); a failed renewal blocks the principal × scheme, and other principals carry on. A refresh names the value the refused request
 * carried: when the store already holds a newer one, that is the answer, and nothing is renewed.
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
	Held,
	HeldCredential,
	RevokeFailure,
	StoreOptions,
} from "./store-types.ts"

interface Entry {
	key: HeldCredential
	credential: Credential
	issued: Issued
	/** Epoch ms the store took it in, which with its expiry gives its lifetime. */
	issuedAt: number
}
type Settled = Entry | Blocked

interface StoreCtx {
	options: StoreOptions
	/** The config's principals and the ones the run enrolled. */
	principals: PrincipalsConfig
	now: () => number
	bufferMs: number
	entries: Map<string, Promise<Settled>>
	/** Principal × scheme pairs a failed refresh blocked. */
	blocked: Map<string, Blocked>
	/** Identity credentials bound, by principal. */
	bound: Map<string, Record<string, string>>
	revokes: Array<{ principal: string; scheme: string; revoke: () => Promise<void> }>
	renew: (held: Entry, start: () => Promise<Settled>) => Promise<Settled>
}

interface Plan {
	principal: string
	scheme: string
	spec: SecurityScheme
	recipe: Partial<Recipe>
	scopes: readonly string[]
	pair: string
	id: string
}

/* Config keys that grade a principal rather than identify it. */
const GRADING: ReadonlySet<string> = /* @__PURE__ */ new Set(["created", "fresh", "inviteAs", "rank", "security"])

/** A credential store for one run. */
export function createStore(options: StoreOptions): CredentialStore {
	const ctx: StoreCtx = {
		blocked: new Map(),
		bound: new Map(),
		bufferMs: options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS,
		entries: new Map(),
		now: options.now ?? Date.now,
		options,
		principals: { ...options.principals },
		renew: createRenewals<Entry, Settled>(),
		revokes: [],
	}
	return {
		acquire: (key) => acquire(ctx, key),
		adopt: (input) => adopt(ctx, input),
		enroll: (id, entry) => {
			ctx.principals[id] = entry
		},
		identityOf: (principal) => identityOf(ctx, principal),
		principals: ctx.principals,
		refresh: (request) => refresh(ctx, request),
		revokeAll: () => revokeAll(ctx),
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
	if (held.credential.value !== request.sentValue) return held.credential
	return renewEntry(ctx, plan, held)
}

async function renewEntry(ctx: StoreCtx, plan: Plan, held: Entry): Promise<Held> {
	const renewed = await ctx.renew(held, () => {
		const next = renewal(ctx, plan, held)
		ctx.entries.set(plan.id, next)
		return next
	})
	return "blocked" in renewed ? renewed : renewed.credential
}

/*
 * A credential with no refresh of its own is renewed by acquiring afresh through its recipe, unless
 * that would run the signup again: then it fails closed, never registering a second account.
 */
async function renewal(ctx: StoreCtx, plan: Plan, held: Entry): Promise<Settled> {
	const signup = signsUp(plan.recipe, ctx.options.signup)
	if (held.issued.refresh === undefined && signup) {
		return blockPair(ctx, plan, `renewing ${plan.principal}/${plan.scheme} would sign up again; declare a refresh`)
	}
	try {
		const renew = held.issued.refresh ?? (() => acquireRecipe(acquireCtx(ctx, plan), plan.recipe))
		return record(ctx, plan, await renew())
	} catch (error) {
		if (held.issued.refresh === undefined || signup) return blockPair(ctx, plan, blockedBy("refresh", plan, error))
	}
	/* A refused declared refresh falls back to one fresh login, shared by concurrent callers; only its failure blocks. */
	const settled = await issue(ctx, plan)
	return "blocked" in settled ? blockPair(ctx, plan, settled.blocked) : settled
}

/* A renewal that failed blocks the principal × scheme for every scope set, for the rest of the run. */
function blockPair(ctx: StoreCtx, plan: Plan, reason: string): Blocked {
	const blocked = { blocked: reason }
	ctx.blocked.set(plan.pair, blocked)
	return blocked
}

async function issue(ctx: StoreCtx, plan: Plan): Promise<Settled> {
	try {
		return record(ctx, plan, await acquireRecipe(acquireCtx(ctx, plan), plan.recipe))
	} catch (error) {
		return { blocked: blockedBy(recipeKind(plan.recipe) ?? "acquire", plan, error) }
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
	let entry: Entry
	try {
		entry = record(ctx, plan, heldIssue(ctx, plan, { scope: input.scope ?? {}, value }))
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
	held: { value: string; scope: Readonly<Record<string, string>> },
): Issued {
	if (recipeKind(plan.recipe) === "login") return heldLogin(acquireCtx(ctx, plan), held, plan.recipe)
	const { value } = held
	return { expiresAt: expiresAtOf({ body: undefined, expiresIn: plan.recipe.expiresIn, now: ctx.now(), value }), value }
}

/* What blocked a credential, as a report names it: the step (a recipe kind, refresh or adopt), for whom, and why. */
function blockedBy(step: string, plan: Plan, error: unknown): string {
	return `${step} for ${plan.principal}/${plan.scheme}: ${messageOf(error)}`
}

function record(ctx: StoreCtx, plan: Plan, issued: Issued): Entry {
	const { secrets, sends } = sendsFor(plan.spec, plan.recipe, issued.value)
	const credential: Credential = { expiresAt: issued.expiresAt, secrets, sends, value: issued.value }
	if (issued.scopes !== undefined) credential.scopes = issued.scopes
	if (issued.identity !== undefined) {
		ctx.bound.set(plan.principal, { ...ctx.bound.get(plan.principal), ...issued.identity })
	}
	if (issued.revoke !== undefined) {
		ctx.revokes.push({ principal: plan.principal, revoke: issued.revoke, scheme: plan.scheme })
	}
	const key = { principal: plan.principal, scheme: plan.scheme, scopes: plan.scopes }
	return { credential, issued, issuedAt: ctx.now(), key: { ...key, credential } }
}

/* Adopting replaces a credential, so a pair a failed refresh blocked can still take one in. */
function planOf(ctx: StoreCtx, key: CredentialKey, how: { adopting?: boolean } = {}): Plan | Blocked {
	const { schemes, security } = ctx.options
	const entry = own(ctx.principals, key.principal)
	if (entry === undefined) return { blocked: `no principal "${key.principal}" in the config` }
	const spec = schemes.get(key.scheme)
	if (spec === undefined) return { blocked: `the document declares no "${key.scheme}" scheme` }
	const recipe = effectiveRecipe(own(security, key.scheme), entry.security?.[key.scheme])
	if (recipe === undefined) {
		return { blocked: `principal "${key.principal}" has no recipe for the "${key.scheme}" scheme` }
	}
	const pair = `${key.principal}\u0000${key.scheme}`
	const blocked = ctx.blocked.get(pair)
	if (blocked !== undefined && how.adopting !== true) return blocked
	const scopes = recipeKind(recipe) === "login" ? [] : [...(key.scopes ?? [])].sort()
	return {
		id: `${pair}\u0000${scopes.join(" ")}`,
		pair,
		principal: key.principal,
		recipe,
		scheme: key.scheme,
		scopes,
		spec,
	}
}

function acquireCtx(ctx: StoreCtx, plan: Plan): AcquireCtx {
	return {
		now: ctx.now,
		ports: ctx.options.ports,
		principal: { id: plan.principal, identity: identityOf(ctx, plan.principal) },
		scheme: plan.spec,
		scopes: plan.scopes,
	}
}

function identityOf(ctx: StoreCtx, principal: string): Readonly<Record<string, unknown>> {
	const data = Object.entries(own(ctx.principals, principal) ?? {}).filter(([key]) => !GRADING.has(key))
	return { ...Object.fromEntries(data), ...ctx.bound.get(principal) }
}

/* A config map's own entry: a principal or scheme named `constructor` is not the prototype's. */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(map, key) ? map[key] : undefined
}

async function snapshot(ctx: StoreCtx): Promise<HeldCredential[]> {
	const settled = await Promise.all(ctx.entries.values())
	return settled.flatMap((held) => ("blocked" in held ? [] : [held.key]))
}

/* One at a time, so a teardown's revokes reach the backend in the order they were minted. */
async function revokeAll(ctx: StoreCtx): Promise<RevokeFailure[]> {
	const failures: RevokeFailure[] = []
	for (const { principal, revoke, scheme } of ctx.revokes.splice(0)) {
		try {
			await revoke()
		} catch (error) {
			failures.push({ principal, reason: messageOf(error), scheme })
		}
	}
	return failures
}
