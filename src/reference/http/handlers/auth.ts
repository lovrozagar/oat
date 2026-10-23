/** Signing in and out: a key or a password for a JWT pair, its rotation, revocation, logout and register. */

import { authenticate } from "../auth/credentials.ts"
import { issueSession, killAll, nextId, revokeJwt, rotate } from "../auth/sessions.ts"
import { noteLogin, throttled } from "../auth/throttle.ts"
import type { Account } from "../auth/types.ts"
import { readFields, readJson } from "../body.ts"
import { HttpError } from "../errors.ts"
import type { ReferenceState } from "../state.ts"
import { noContent, type ReferenceRequest, type ReferenceResponse, respond } from "../wire.ts"
import type { Route } from "./fixed.ts"

const is = (request: ReferenceRequest, method: string, pathname: string): boolean =>
	request.method === method && request.url.pathname === pathname

/* A sign-in for `identity`: throttled first, then the account `find` names, or a counted failure. */
function signIn(state: ReferenceState, identity: string, find: () => Account | undefined): ReferenceResponse {
	const refused = throttled(state, identity)
	if (refused !== undefined) return refused
	const account = find()
	noteLogin(state, identity, account !== undefined)
	if (account === undefined) throw new HttpError(401, "unauthorized", "unknown credentials")
	return respond(200, issueSession(state, account))
}

/** `auth.token { key }`: an API key for a JWT pair. */
export const token: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/auth/token")) return undefined
	const key = (await readJson(request)) as { key?: unknown } | null
	const named = typeof key?.key === "string" ? key.key : ""
	return signIn(state, `key:${named}`, () => state.auth.accounts.get(named))
}

/** `auth.login { email, password }`: a password for a JWT pair. Declared public; guarded under PUBLIC_ROUTE_GUARDED. */
export const login: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/auth/login")) return undefined
	if (state.defects.has("PUBLIC_ROUTE_GUARDED")) authenticate(state, request)
	const { email, password } = (await readFields(request, state.defects, { email: "string", password: "string" })) as {
		email: string
		password: string
	}
	const accounts = [...state.auth.accounts.values()]
	return signIn(state, `email:${email}`, () =>
		accounts.find((account) => account.email === email && account.password === password),
	)
}

/** `auth.refresh { refresh_token }`: a new pair; the presented refresh token is spent. */
export const refresh: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/auth/refresh")) return undefined
	const body = await readFields(request, state.defects, { refresh_token: "string" })
	return respond(200, rotate(state, body["refresh_token"] as string))
}

/** `auth.revoke { token }`: revokes one of the caller's own access or refresh tokens. */
export const revokeToken: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/auth/revoke")) return undefined
	const caller = authenticate(state, request)
	const body = await readFields(request, state.defects, { token: "string" })
	revokeJwt(state, caller, body["token"] as string)
	return respond(200, { revoked: true })
}

/** `auth.logout`: revokes the caller's access token, or, under DISPOSABLE_KILLS_CALLER, everyone's. */
export const logout: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/logout")) return undefined
	const caller = authenticate(state, request)
	if (state.defects.has("DISPOSABLE_KILLS_CALLER")) killAll(state.auth)
	else if (caller.jti !== undefined) state.auth.revoked.add(caller.jti)
	return respond(200, { ok: true })
}

/** `auth.register { email }`: a fresh admin of the first tenant, signed in at once. A body it cannot read is a 400. */
export const register: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/register")) return undefined
	const { email } = (await readFields(request, state.defects, { email: "string" })) as { email: string }
	const account: Account = { email, key: nextId(state.auth, "disp"), projectId: "proj_alpha", rank: 2 }
	state.auth.accounts.set(account.key, account)
	state.auth.registered.push(email)
	return respond(201, { access_token: issueSession(state, account).access_token, account_id: account.key })
}

/* Gone: no sign-in finds it, and every token it holds is refused. */
function removeAccount(state: ReferenceState, key: string): void {
	state.auth.accounts.delete(key)
	state.auth.killed.add(key)
}

/** `profile.delete`: the caller deletes its own account. */
export const deleteSelf: Route = async (state, request) => {
	if (!is(request, "DELETE", "/v1/me")) return undefined
	removeAccount(state, authenticate(state, request).key)
	return noContent()
}

/** `account.delete`: an admin (rank 2) deletes an account of its own project. */
export const deleteAccount: Route = async (state, request) => {
	const match = /^\/v1\/signups\/([^/]+)$/.exec(request.url.pathname)
	if (match === null || request.method !== "DELETE") return undefined
	const caller = authenticate(state, request)
	const target = state.auth.accounts.get(decodeURIComponent(match[1] as string))
	if (target === undefined || target.projectId !== caller.projectId)
		throw new HttpError(404, "not_found", "no such account")
	if (caller.rank < 2) throw new HttpError(403, "forbidden", "only an admin deletes an account")
	removeAccount(state, target.key)
	return noContent()
}
