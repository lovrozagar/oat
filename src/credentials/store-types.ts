/* What a run's credential store is given, holds and answers; `createStore` in store.ts makes one. */

import type { PrincipalEntry, PrincipalsConfig, SecurityConfig } from "../config/types/security.ts"
import type { Secrets } from "./placement.ts"
import type { CredentialPorts, Sends } from "./ports.ts"
import type { SignupOperation } from "./signup.ts"
import type { SecurityScheme } from "../spec/security/schemes.ts"

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
	/** The document's `x-fresh-principal` operation: a login calling it with no `refresh` is never re-run. */
	signup?: SignupOperation
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

/** A credential the store holds, and whose it is. */
export interface HeldCredential {
	principal: string
	scheme: string
	/** The scope set it is keyed by, sorted: empty for a login, which holds whatever the server grants. */
	scopes: readonly string[]
	credential: Credential
}

/** A credential the run was handed, for whom and which scheme. */
export interface Adopting {
	principal: string
	scheme: string
	value: string
	/** What came with it, a signup's `refresh_token` say: a login recipe's declared refresh runs from it. */
	scope?: Readonly<Record<string, string>>
}

/** A dedicated session after its recipe's refresh rotated it. */
export interface Rotated {
	credential: Credential
	/** Runs the refresh again from before the rotation; rejects with the reason when it is refused. */
	replay(): Promise<void>
}

/**
 * How a probe uses a dedicated credential. `reusable`: it never spends it (no revoke, no rotation),
 * so one per principal, scheme and scope set serves every such probe of the run.
 */
export interface DedicatedUse {
	reusable?: boolean
}

/**
 * A credential for a probe alone, never the owner's own session: held under the probe principal
 * `<owner>#probe-<n>`, and revoked at teardown when its recipe declares how.
 */
export interface DedicatedHeld {
	principal: string
	owner: string
	scheme: string
	credential: Credential
	/** Revokes it now through the declared revoke; absent without one. Rejects with the reason, and teardown tries again. */
	revoke?: () => Promise<void>
	/** Rotates it by the recipe's declared refresh; absent without one. */
	rotate?: () => Promise<Rotated>
}

/** A credential teardown could not revoke: a record the report lists as unremovable. */
export interface RevokeFailure {
	principal: string
	scheme: string
	reason: string
}

export interface CredentialStore {
	acquire(key: CredentialKey): Promise<Held>
	/**
	 * A credential of the principal's own that is not its session: a second login, a fresh mint, a new
	 * token grant, under a probe principal the store enrolls. Static and hook recipes cannot issue one.
	 */
	acquireDedicated(key: CredentialKey, use?: DedicatedUse): Promise<DedicatedHeld | Blocked>
	/** Renews the credential a refused request carried, once however many requests were refused. */
	refresh(request: CredentialKey & { sentValue: string }): Promise<Held>
	/**
	 * BLOCKS the principal × scheme for the rest of the run, as a failed renewal does: a control read
	 * showed the server refuses its credential anywhere. Adopting a credential lifts it.
	 */
	block(key: CredentialKey, reason: string): void
	/**
	 * Holds `value` as the principal's credential for the scheme, placed like any acquired one: the
	 * credential an invite issued its delegate, or the one a signup answered with. It replaces what
	 * was held, a blocked login included.
	 */
	adopt(input: Adopting): Promise<Held>
	/** Adds a principal of the run's own, a fresh or disposable one, which acquires by the shared recipes. */
	enroll(id: string, entry: PrincipalEntry): void
	/** Every principal by id, the enrolled ones included. Live: an adapter reads it as enrolling adds to it. */
	readonly principals: Readonly<PrincipalsConfig>
	/** The principal's identity: its config data, plus what its credentials bound. */
	identityOf(principal: string): Readonly<Record<string, unknown>>
	/** Every credential held now, in the order first acquired; blocked ones are left out. */
	snapshot(): Promise<HeldCredential[]>
	/** Revokes every credential that recorded a revoke; returns the ones that failed. */
	revokeAll(): Promise<RevokeFailure[]>
	/**
	 * Ends each principal's own login session that `of` admits, by the login recipe's declared
	 * `revoke`, once per principal and scheme; returns the ones that failed. Nothing is sent for a
	 * login that declares no revoke.
	 */
	revokeSessions(of: (principal: string) => boolean): Promise<RevokeFailure[]>
}
