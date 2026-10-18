import type { PrincipalsConfig, Recipe, SecurityConfig } from "../config/types/security.ts"
import { messageOf } from "../errors/message.ts"
import type { SecurityScheme } from "../spec/security/schemes.ts"
import { effectiveRecipe } from "./effective.ts"
import { type Secrets, sendsFor } from "./placement.ts"
import type { CredentialPorts, Sends } from "./ports.ts"
import { acquireRecipe, recipeKind } from "./recipes/acquire.ts"
import type { AcquireCtx, Issued } from "./recipes/types.ts"
import { createRenewals, DEFAULT_REFRESH_BUFFER_MS, isStale } from "./refresh.ts"

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
 * attempted once per principal and scheme per run. A failed refresh blocks that principal × scheme
 * for every scope set, and other principals carry on. A refresh names the value the refused request
 * carried: when the store already holds a newer one, that is the answer, and nothing is renewed.
 */

export interface StoreOptions {
	security: SecurityConfig
	principals: PrincipalsConfig
	/** The document's schemes by name. */
	schemes: ReadonlyMap<string, SecurityScheme>
	ports: CredentialPorts
	/** Epoch ms now. Default: the system clock. */
	now?: () => number
	/** How long before it lapses a credential is renewed. Default: 30 s. */
	refreshBufferMs?: number
}

/** Which credential: whose, for which scheme, carrying which scopes. */
export interface CredentialKey {
	principal: string
	scheme: string
	scopes?: readonly string[]
}

/** A held credential, placed and ready to send. */
export interface Credential {
	value: string
	expiresAt: number | null
	sends: Sends
	secrets: Secrets
	/** The scopes it was issued for, when its recipe asked for them. */
	scopes?: readonly string[]
}

/** A credential the run cannot have, and why. It stays blocked for the rest of the run. */
export interface Blocked {
	blocked: string
}

export type Held = Credential | Blocked

/** A credential teardown could not revoke: a record the report lists as unremovable. */
export interface RevokeFailure {
	principal: string
	scheme: string
	reason: string
}

export interface CredentialStore {
	acquire(key: CredentialKey): Promise<Held>
	/** Renews the credential a refused request carried, once however many requests were refused. */
	refresh(request: CredentialKey & { sentValue: string }): Promise<Held>
	/** The principal's identity: its config data, plus what its credentials bound. */
	identityOf(principal: string): Readonly<Record<string, unknown>>
	/** Revokes every credential that recorded a revoke; returns the ones that failed. */
	revokeAll(): Promise<RevokeFailure[]>
}

interface Entry {
	credential: Credential
	issued: Issued
	/** Epoch ms the store took it in, which with its expiry gives its lifetime. */
	issuedAt: number
}
type Settled = Entry | Blocked

interface StoreCtx {
	options: StoreOptions
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
const GRADING: ReadonlySet<string> = /* @__PURE__ */ new Set(["fresh", "inviteAs", "rank", "security"])

/** A credential store for one run. */
export function createStore(options: StoreOptions): CredentialStore {
	const ctx: StoreCtx = {
		blocked: new Map(),
		bound: new Map(),
		bufferMs: options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS,
		entries: new Map(),
		now: options.now ?? Date.now,
		options,
		renew: createRenewals<Entry, Settled>(),
		revokes: [],
	}
	return {
		acquire: (key) => acquire(ctx, key),
		identityOf: (principal) => identityOf(ctx, principal),
		refresh: (request) => refresh(ctx, request),
		revokeAll: () => revokeAll(ctx),
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

/* A credential with no refresh of its own is renewed by acquiring afresh through its recipe. */
async function renewal(ctx: StoreCtx, plan: Plan, held: Entry): Promise<Settled> {
	try {
		const renew = held.issued.refresh ?? (() => acquireRecipe(acquireCtx(ctx, plan), plan.recipe))
		return record(ctx, plan, await renew())
	} catch (error) {
		const blocked = {
			blocked: `could not refresh the "${plan.scheme}" credential for "${plan.principal}": ${messageOf(error)}`,
		}
		ctx.blocked.set(plan.pair, blocked)
		return blocked
	}
}

async function issue(ctx: StoreCtx, plan: Plan): Promise<Settled> {
	try {
		return record(ctx, plan, await acquireRecipe(acquireCtx(ctx, plan), plan.recipe))
	} catch (error) {
		return { blocked: `could not acquire the "${plan.scheme}" credential for "${plan.principal}": ${messageOf(error)}` }
	}
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
	return { credential, issued, issuedAt: ctx.now() }
}

function planOf(ctx: StoreCtx, key: CredentialKey): Plan | Blocked {
	const { principals, schemes, security } = ctx.options
	const entry = own(principals, key.principal)
	if (entry === undefined) return { blocked: `no principal "${key.principal}" in the config` }
	const spec = schemes.get(key.scheme)
	if (spec === undefined) return { blocked: `the document declares no "${key.scheme}" scheme` }
	const recipe = effectiveRecipe(own(security, key.scheme), entry.security?.[key.scheme])
	if (recipe === undefined) {
		return { blocked: `principal "${key.principal}" has no recipe for the "${key.scheme}" scheme` }
	}
	const pair = `${key.principal}\u0000${key.scheme}`
	const blocked = ctx.blocked.get(pair)
	if (blocked !== undefined) return blocked
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
		sendsOf: async (scheme) => {
			const held = await acquire(ctx, { principal: plan.principal, scheme })
			if ("blocked" in held) throw new Error(held.blocked)
			return held.sends
		},
	}
}

function identityOf(ctx: StoreCtx, principal: string): Readonly<Record<string, unknown>> {
	const data = Object.entries(own(ctx.options.principals, principal) ?? {}).filter(([key]) => !GRADING.has(key))
	return { ...Object.fromEntries(data), ...ctx.bound.get(principal) }
}

/* A config map's own entry: a principal or scheme named `constructor` is not the prototype's. */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(map, key) ? map[key] : undefined
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
