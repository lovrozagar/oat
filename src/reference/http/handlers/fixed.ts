/** The routes outside the entity model: the document, health, notices, the caller's own records. */

import { buildSpec, buildUntaggedSpec } from "../../spec/build.ts"
import { assertTenant } from "../access.ts"
import { authenticate } from "../auth/credentials.ts"
import type { Account, Principal } from "../auth/types.ts"
import { readJson, requireJson } from "../body.ts"
import { HttpError } from "../errors.ts"
import type { ReferenceState } from "../state.ts"
import { type ReferenceRequest, type ReferenceResponse, respond } from "../wire.ts"

/** A route: its answer, or `undefined` when the request is not one of its. */
export type Route = (state: ReferenceState, request: ReferenceRequest) => Promise<ReferenceResponse | undefined>

const is = (request: ReferenceRequest, method: string, pathname: string): boolean =>
	request.method === method && request.url.pathname === pathname

export const document: Route = async (state, request) => {
	if (request.url.pathname !== "/v1/openapi/spec") return undefined
	const context = { entities: state.entities, shape: state.shape }
	return respond(200, state.untagged ? buildUntaggedSpec(state.dialect, context) : buildSpec(state.dialect, context))
}

export const health: Route = async (state, request) => {
	if (!is(request, "GET", "/health")) return undefined
	if (state.defects.has("PUBLIC_GET_NOT_SUCCESS")) return respond(500, { error_key: "internal_server_error" })
	return respond(200, { ok: true })
}

export const notices: Route = async (state, request) => {
	if (is(request, "GET", "/v1/notices")) {
		/* The one secured route that forgets to ask, under AUTH_IGNORED_ON_ROUTE. */
		if (!state.defects.has("AUTH_IGNORED_ON_ROUTE")) authenticate(state, request)
		return respond(200, { notices: [{ id: "note_1", title: "Hello" }] })
	}
	const notice = /^\/v1\/notices\/([^/]+)$/.exec(request.url.pathname)
	if (notice === null || request.method !== "GET") return undefined
	authenticate(state, request)
	if (notice[1] !== "note_1") throw new HttpError(404, "not_found", "notice note_1 does not exist")
	return respond(200, { id: "note_1", title: state.defects.has("LISTED_GET_DIFFERS") ? "Other" : "Hello" })
}

export const overview: Route = async (state, request) => {
	const match = /^\/v1\/projects\/([^/]+)\/overview$/.exec(request.url.pathname)
	if (match === null || request.method !== "GET") return undefined
	if (!state.defects.has("ROOT_READ_OPEN")) authenticate(state, request)
	return respond(200, { extractions: 0, project_id: match[1] as string })
}

export const me: Route = async (state, request) => {
	if (request.url.pathname !== "/v1/me" || (request.method !== "GET" && request.method !== "PATCH")) return undefined
	const principal = authenticate(state, request)
	const current = state.profiles.get(principal.key) ?? { first_name: "Ada" }
	if (request.method === "GET") return respond(200, current)
	requireJson(request, state.defects)
	const body = await readJson(request)
	const name = body !== null && typeof body === "object" ? (body as { first_name?: unknown }).first_name : undefined
	if (typeof name !== "string" || name.length === 0 || name.length > 64) {
		throw new HttpError(400, "invalid_input", 'field "first_name" must be a string')
	}
	const next = { first_name: name }
	if (state.defects.has("CALLER_UPDATE_DROPPED")) return respond(200, current)
	state.profiles.set(principal.key, next)
	return respond(200, next)
}

/* What `account.update` may set: each a string, the email an address and the password 8 or more long. */
const ACCOUNT_FIELDS: Readonly<Record<string, (value: string) => boolean>> = {
	display_name: (value) => value.length <= 64,
	email: (value) => /^[^@\s]+@[^@\s]+$/.test(value),
	password: (value) => value.length >= 8,
}

/** `account.update`: the caller's own sign-in email and password, and its display name; the next login reads them. */
export const account: Route = async (state, request) => {
	if (!is(request, "PUT", "/v1/me/account")) return undefined
	const principal = authenticate(state, request)
	requireJson(request, state.defects)
	const body = await readJson(request)
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "invalid_input", "request body must be an object")
	}
	for (const [name, value] of Object.entries(body)) {
		const valid = ACCOUNT_FIELDS[name]
		if (valid === undefined) throw new HttpError(400, "invalid_input", `field "${name}" is not allowed`)
		if (typeof value !== "string" || !valid(value))
			throw new HttpError(400, "invalid_input", `field "${name}" is invalid`)
	}
	const { display_name: displayName, email, password } = body as Record<string, string | undefined>
	/* An authenticated caller is an account. The accounts are shared constants: replace, never mutate. */
	const current = state.auth.accounts.get(principal.key) as Account
	const next: Account = {
		...current,
		...(displayName === undefined ? {} : { displayName }),
		...(email === undefined ? {} : { email }),
		...(password === undefined ? {} : { password }),
	}
	state.auth.accounts.set(principal.key, next)
	/* A field the account has no value for is left out of the JSON. */
	return respond(200, { display_name: next.displayName, email: next.email })
}

/** A project-scoped route: the caller and the project the path names, which must be theirs. */
export function ownProject(state: ReferenceState, request: ReferenceRequest, projectId: string): Principal {
	const principal = authenticate(state, request)
	assertTenant(principal, projectId)
	return principal
}
