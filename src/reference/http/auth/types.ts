/** What the server keeps about sign-ins: accounts, issued and revoked tokens, API keys and failed logins. */

/** The roles a token carries: viewer, member, admin, at ranks 0, 1 and 2. */
export type Role = "viewer" | "member" | "admin"

/** Who a request acts as. Higher rank can do everything a lower rank can. */
export interface Principal {
	key: string
	projectId: string
	rank: number
	/** The access token's id, when a JWT authenticated the request. */
	jti?: string
}

/** Someone who can sign in: by key at `auth.token`, or by email and password at `auth.login`. */
export interface Account extends Principal {
	email?: string
	password?: string
}

/** An API key: bound to its creator's tenant and rank, and to the scopes it was made with. */
export interface ApiKey {
	id: string
	value: string
	sub: string
	projectId: string
	rank: number
	scopes: readonly string[]
	revoked: boolean
}

/** The claims every token the server issues carries. */
export interface Claims {
	sub: string
	project_id: string
	role: Role
	typ: "access" | "refresh"
	/** The session family: every token a refresh rotates out of one sign-in shares it. */
	fam: string
	jti: string
	iat: number
	exp: number
}

/** A sign-in's answer, as `auth.token`, `auth.login` and `auth.refresh` give it. */
export interface Session {
	access_token: string
	refresh_token: string
	expires_in: number | string
	project_id: string
}

export interface AuthState {
	/** Signs every JWT. */
	secret: string
	/** Milliseconds since the epoch: expiry and the login throttle read it. */
	clock: () => number
	/** Under `throttleLogins`: too many failed logins for one identity answer 429. */
	throttle: boolean
	/** Numbers the jti, family and API key ids, apart from the record ids so those stay put. */
	sequence: number
	/** By key: the seeded principals, then whoever registered. */
	accounts: Map<string, Account>
	/** Revoked token ids. */
	revoked: Set<string>
	/** Session families revoked whole, on refresh-token reuse. */
	revokedFamilies: Set<string>
	/** Refresh token ids already rotated: presenting one again is reuse. */
	rotated: Set<string>
	/** Subjects whose every token is refused, issued before or after. */
	killed: Set<string>
	/** By value. */
	apiKeys: Map<string, ApiKey>
	/** Failed login instants, per identity, while throttling. */
	failures: Map<string, number[]>
}
