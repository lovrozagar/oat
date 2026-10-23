/** Sign-in sessions: issuing JWT pairs, verifying an access token, rotating a refresh token, revoking. */

import { HttpError } from "../errors.ts"
import type { ReferenceOptions, ReferenceState } from "../state.ts"
import { PRINCIPALS } from "../state.ts"
import { decodeJwt, signJwt } from "./jwt.ts"
import type { AuthState, Claims, Principal, Role, Session } from "./types.ts"

/* The roles a token carries, at their rank: viewer 0, member 1, admin 2. */
const ROLES: readonly Role[] = ["viewer", "member", "admin"]

const ACCESS_SECONDS = 3600
const REFRESH_SECONDS = 30 * 86_400

/** A fresh server's sign-in state: the principals as accounts, nothing issued yet. */
export function newAuthState(options: ReferenceOptions): AuthState {
	return {
		accounts: new Map(PRINCIPALS.map((account) => [account.key, account])),
		apiKeys: new Map(),
		clock: options.clock ?? Date.now,
		failures: new Map(),
		killed: new Set(),
		revoked: new Set(),
		revokedFamilies: new Set(),
		rotated: new Set(),
		secret: "oat-reference-secret",
		sequence: 0,
		throttle: options.throttleLogins === true,
	}
}

/** The next id in the auth sequence, as `<prefix>_<n>`. */
export function nextId(auth: AuthState, prefix: string): string {
	auth.sequence += 1
	return `${prefix}_${auth.sequence}`
}

const unauthorized = (message: string): HttpError => new HttpError(401, "unauthorized", message)

/** An access and a refresh token for `principal`, in `family` or a new one. */
export function issueSession(state: ReferenceState, principal: Principal, family?: string): Session {
	const { auth } = state
	const fam = family ?? nextId(auth, "fam")
	const iat = Math.floor(auth.clock() / 1000)
	const base = { fam, iat, project_id: principal.projectId, role: ROLES[principal.rank], sub: principal.key }
	const sign = (typ: Claims["typ"], seconds: number): string =>
		signJwt(auth.secret, { ...base, exp: iat + seconds, jti: nextId(auth, "jti"), typ })
	const access = sign("access", ACCESS_SECONDS)
	return {
		access_token: access,
		expires_in: state.defects.has("TOKEN_EXPIRY_AS_STRING") ? String(ACCESS_SECONDS) : ACCESS_SECONDS,
		project_id: principal.projectId,
		refresh_token: sign("refresh", REFRESH_SECONDS),
	}
}

/* The claims, when every one the server issues is there with its type. */
function asClaims(raw: Record<string, unknown>): Claims | undefined {
	const strings = ["sub", "project_id", "typ", "fam", "jti"].every((name) => typeof raw[name] === "string")
	const numbers = typeof raw["exp"] === "number" && typeof raw["iat"] === "number"
	return strings && numbers && ROLES.includes(raw["role"] as Claims["role"]) ? (raw as unknown as Claims) : undefined
}

/* A token's claims, once it holds: signed (unless TOKEN_NOT_VERIFIED), of `typ`, unexpired and unrevoked. */
function claimsOf(state: ReferenceState, token: string, typ: Claims["typ"]): Claims {
	const { auth, defects } = state
	const decoded = decodeJwt(auth.secret, token)
	if (decoded === null) throw unauthorized("malformed token")
	if (!decoded.signed && !defects.has("TOKEN_NOT_VERIFIED")) throw unauthorized("bad token signature")
	const claims = asClaims(decoded.claims)
	if (claims === undefined) throw unauthorized("malformed token claims")
	if (claims.typ !== typ) throw unauthorized(`not ${typ === "access" ? "an access" : "a refresh"} token`)
	if (claims.exp * 1000 <= auth.clock()) throw unauthorized("token expired")
	const revoked =
		!defects.has("REVOKED_TOKEN_ACCEPTED") && (auth.revoked.has(claims.jti) || auth.revokedFamilies.has(claims.fam))
	if (revoked || auth.killed.has(claims.sub)) throw unauthorized("token revoked")
	return claims
}

/** Who a live access token authenticates: its subject, tenant, role and token id, as it claims them. */
export function accessPrincipal(state: ReferenceState, token: string): Principal {
	const claims = claimsOf(state, token, "access")
	return { jti: claims.jti, key: claims.sub, projectId: claims.project_id, rank: ROLES.indexOf(claims.role) }
}

/** A new pair for a live refresh token, which is spent. Presenting a spent one revokes its whole family. */
export function rotate(state: ReferenceState, refreshToken: string): Session {
	const claims = claimsOf(state, refreshToken, "refresh")
	const { auth } = state
	if (auth.rotated.has(claims.jti) && !state.defects.has("REFRESH_REUSE_ACCEPTED")) {
		auth.revokedFamilies.add(claims.fam)
		throw unauthorized("refresh token reused; its session is revoked")
	}
	auth.rotated.add(claims.jti)
	const principal = { key: claims.sub, projectId: claims.project_id, rank: ROLES.indexOf(claims.role) }
	return issueSession(state, principal, claims.fam)
}

/** Revokes one of the caller's own tokens, access or refresh. */
export function revokeJwt(state: ReferenceState, caller: Principal, token: string): void {
	const decoded = decodeJwt(state.auth.secret, token)
	if (decoded === null || !decoded.signed) {
		throw new HttpError(400, "invalid_input", "the token is not one this server issued")
	}
	if (decoded.claims["sub"] !== caller.key)
		throw new HttpError(403, "forbidden", "the token belongs to another principal")
	state.auth.revoked.add(String(decoded.claims["jti"]))
}

/** Refuses every account's tokens from now on, whenever issued: the whole user base is signed out. */
export function killAll(auth: AuthState): void {
	for (const key of auth.accounts.keys()) auth.killed.add(key)
}
