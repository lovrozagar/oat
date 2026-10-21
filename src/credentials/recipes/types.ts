import type { CredentialPrincipal } from "../../config/types/hooks.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import type { CredentialPorts, Hop } from "../ports.ts"

/** What a recipe acquires a credential with: the run's ports, who it is for, and what it must carry. */
export interface AcquireCtx {
	ports: CredentialPorts
	principal: CredentialPrincipal
	/** The scheme the credential is for; an oauth2 scheme also names the token URL. */
	scheme: SecurityScheme
	/** The scopes the operation needs, sorted. Empty when it names none. */
	scopes: readonly string[]
	/** Epoch ms now; a run passes its clock so tests can move it. */
	now: () => number
}

/** A credential a recipe issued. */
export interface Issued {
	value: string
	/** Epoch ms it lapses, or null when it never does as far as oat can tell. */
	expiresAt: number | null
	/** Renews it. Absent: the store acquires a fresh one by the same recipe. */
	refresh?: (hop?: Hop) => Promise<Issued>
	/** Revokes it when the run is done with it. */
	revoke?: () => Promise<void>
	/** Identity the credential bound, e.g. a login's `claims`. */
	identity?: Record<string, string>
	/** The scopes it was issued for, when the recipe asked for them. */
	scopes?: readonly string[]
}
