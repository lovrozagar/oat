/*
 * The store's internals, shared by store.ts and dedicated.ts: the state one store holds, how a key is
 * planned against the config, and how an issued credential is recorded. Nothing here is exported
 * beyond the credentials library.
 */

import type { PrincipalsConfig, Recipe } from "../config/types/security.ts"
import { messageOf } from "../errors/message.ts"
import type { SecurityScheme } from "../spec/security/schemes.ts"
import { effectiveRecipe, own } from "./effective.ts"
import { sendsFor } from "./placement.ts"
import { probeOwner, withoutProbes } from "./probe-principal.ts"
import { recipeKind } from "./recipes/acquire.ts"
import { createRenewals, DEFAULT_REFRESH_BUFFER_MS } from "./refresh.ts"
import type { CredentialRecord } from "./ports.ts"
import type { AcquireCtx, Issued } from "./recipes/types.ts"
import type { Blocked, Credential, CredentialKey, DedicatedHeld, HeldCredential, StoreOptions } from "./store-types.ts"

/** A credential the store holds, as issued, and the revoke it registered. */
export interface Entry {
	key: HeldCredential
	credential: Credential
	issued: Issued
	/** Epoch ms the store took it in, which with its expiry gives its lifetime. */
	issuedAt: number
	/** Its revoke's key in `StoreCtx.revokes`, when it registered one. */
	revokeKey?: string
	/** The value a renewal replaced: refused again, it is not renewed twice, even when the server reissued it. */
	renewedFrom?: string
}
export type Settled = Entry | Blocked

/** A revoke teardown runs: whose credential it ends, by the principal a report names, and which scheme. */
export interface Revoking {
	principal: string
	scheme: string
	revoke: () => Promise<void>
	/** The record the revoke removes, for a minted credential. */
	record?: CredentialRecord
}

export interface StoreCtx {
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
	/** Revokes teardown runs, in the order registered. A session's renewal replaces its own. */
	revokes: Map<string, Revoking>
	/** Revokes registered so far, which keeps each mint's key distinct. */
	registered: number
	/** The probe principals dedicated credentials are held under. */
	dedicated: Set<string>
	/** Probe principals enrolled so far, which numbers the next. */
	probes: number
	/** The dedicated credentials probes that never spend one share, by principal, scheme and scope set. */
	shared: Map<string, Promise<DedicatedHeld | Blocked>>
	renew: (held: Entry, start: () => Promise<Settled>) => Promise<Settled>
}

export interface Plan {
	principal: string
	scheme: string
	spec: SecurityScheme
	recipe: Partial<Recipe>
	scopes: readonly string[]
	pair: string
	id: string
}

/** A store's state, empty: the config's principals copied, so enrolling never edits the config. */
export function storeCtx(options: StoreOptions): StoreCtx {
	return {
		blocked: new Map(),
		bound: new Map(),
		bufferMs: options.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS,
		dedicated: new Set(),
		entries: new Map(),
		now: options.now ?? Date.now,
		options,
		principals: { ...options.principals },
		probes: 0,
		registered: 0,
		renew: createRenewals<Entry, Settled>(),
		revokes: new Map(),
		shared: new Map(),
	}
}

/* Config keys that grade a principal rather than identify it. */
const GRADING: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"created",
	"fresh",
	"inviteAs",
	"rank",
	"readOnly",
	"security",
])

/** What blocked a credential, as a report names it: the step (a recipe kind, refresh or adopt), for whom, and why. */
export function blockedBy(step: string, plan: Plan, error: unknown): string {
	return `${step} for ${probeOwner(plan.principal)}/${plan.scheme}: ${withoutProbes(messageOf(error))}`
}

/**
 * Takes an issued credential in. Its revoke is registered for teardown, except a login's for a
 * principal's own session: a login's revoke is for the dedicated sessions probes open, and ending a
 * principal's own would strand what teardown still sends as it.
 */
export function record(ctx: StoreCtx, plan: Plan, issued: Issued): Entry {
	const { secrets, sends } = sendsFor(plan.spec, plan.recipe, issued.value)
	const credential: Credential = { expiresAt: issued.expiresAt, secrets, sends, value: issued.value }
	if (issued.scopes !== undefined) credential.scopes = issued.scopes
	if (issued.identity !== undefined) {
		ctx.bound.set(plan.principal, { ...ctx.bound.get(plan.principal), ...issued.identity })
	}
	const key = { principal: plan.principal, scheme: plan.scheme, scopes: plan.scopes }
	const entry: Entry = { credential, issued, issuedAt: ctx.now(), key: { ...key, credential } }
	const login = recipeKind(plan.recipe) === "login"
	if (issued.revoke !== undefined && (!login || ctx.dedicated.has(plan.principal))) {
		/* A session is one credential however often it rotates; each mint is a key of its own. */
		entry.revokeKey = login ? plan.id : `${plan.id}\u0000${ctx.registered}`
		const removes = issued.record === undefined ? {} : { record: issued.record }
		registerRevoke(ctx, plan, { key: entry.revokeKey, revoke: issued.revoke, ...removes })
	}
	return entry
}

/** Registers a revoke teardown runs, under `key`; a later one under the same key replaces it. */
export function registerRevoke(
	ctx: StoreCtx,
	plan: Plan,
	{ key, ...revoking }: { key: string } & Omit<Revoking, "principal" | "scheme">,
): void {
	ctx.registered += 1
	ctx.revokes.set(key, { ...revoking, principal: probeOwner(plan.principal), scheme: plan.scheme })
}

/** What a block holds for: the principal × scheme, whatever the scopes. */
export function pairOf(key: Pick<CredentialKey, "principal" | "scheme">): string {
	return `${key.principal}\u0000${key.scheme}`
}

/* Adopting replaces a credential, so a pair a failed refresh blocked can still take one in. */
export function planOf(ctx: StoreCtx, key: CredentialKey, how: { adopting?: boolean } = {}): Plan | Blocked {
	const { schemes, security } = ctx.options
	const entry = own(ctx.principals, key.principal)
	if (entry === undefined) return { blocked: `no principal "${key.principal}" in the config` }
	const spec = schemes.get(key.scheme)
	if (spec === undefined) return { blocked: `the document declares no "${key.scheme}" scheme` }
	const recipe = effectiveRecipe(own(security, key.scheme), entry.security?.[key.scheme])
	if (recipe === undefined) {
		return { blocked: `principal "${key.principal}" has no recipe for the "${key.scheme}" scheme` }
	}
	const pair = pairOf(key)
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

export function acquireCtx(ctx: StoreCtx, plan: Plan): AcquireCtx {
	return {
		now: ctx.now,
		ports: ctx.options.ports,
		principal: { id: plan.principal, identity: identityOf(ctx, plan.principal) },
		scheme: plan.spec,
		scopes: plan.scopes,
	}
}

export function identityOf(ctx: StoreCtx, principal: string): Readonly<Record<string, unknown>> {
	const data = Object.entries(own(ctx.principals, principal) ?? {}).filter(([key]) => !GRADING.has(key))
	return { ...Object.fromEntries(data), ...ctx.bound.get(principal) }
}
