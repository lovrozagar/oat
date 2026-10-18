/** The routes outside the entity model: the document, tokens, health, notices, the caller's own records. */

import { buildSpec, buildUntaggedSpec } from "../../spec/build.ts"
import { assertTenant, authenticate, bearer } from "../access.ts"
import { readJson, requireJson } from "../body.ts"
import { HttpError } from "../errors.ts"
import { PRINCIPALS, type ReferenceState } from "../state.ts"
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

export const token: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/auth/token")) return undefined
	const body = await readJson(request)
	const principal = PRINCIPALS.find((p) => p.key === (body as { key?: unknown }).key)
	if (principal === undefined) throw new HttpError(401, "unauthorized", "unknown API key")
	return respond(200, {
		access_token: principal.token,
		expires_in: state.defects.has("TOKEN_EXPIRY_AS_STRING") ? "3600" : 3600,
		project_id: principal.projectId,
	})
}

export const health: Route = async (state, request) => {
	if (!is(request, "GET", "/health")) return undefined
	if (state.defects.has("PUBLIC_GET_NOT_SUCCESS")) return respond(500, { error_key: "internal_server_error" })
	return respond(200, { ok: true })
}

export const notices: Route = async (state, request) => {
	if (is(request, "GET", "/v1/notices")) {
		authenticate(state, request)
		return respond(200, { notices: [{ id: "note_1", title: "Hello" }] })
	}
	const notice = /^\/v1\/notices\/([^/]+)$/.exec(request.url.pathname)
	if (notice === null || request.method !== "GET") return undefined
	authenticate(state, request)
	if (notice[1] !== "note_1") throw new HttpError(404, "not_found", "notice note_1 does not exist")
	return respond(200, { id: "note_1", title: state.defects.has("LISTED_GET_DIFFERS") ? "Other" : "Hello" })
}

export const register: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/register")) return undefined
	const issued = `tok_disp_${state.liveTokens.size}`
	state.liveTokens.add(issued)
	return respond(201, { access_token: issued })
}

export const logout: Route = async (state, request) => {
	if (!is(request, "POST", "/v1/logout")) return undefined
	if (state.defects.has("DISPOSABLE_KILLS_CALLER")) state.liveTokens.clear()
	else state.liveTokens.delete(bearer(request) ?? "")
	return respond(200, { ok: true })
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
	const current = state.profiles.get(principal.token) ?? { first_name: "Ada" }
	if (request.method === "GET") return respond(200, current)
	requireJson(request, state.defects)
	const body = await readJson(request)
	const name = body !== null && typeof body === "object" ? (body as { first_name?: unknown }).first_name : undefined
	if (typeof name !== "string" || name.length === 0 || name.length > 64) {
		throw new HttpError(400, "invalid_input", 'field "first_name" must be a string')
	}
	const next = { first_name: name }
	if (state.defects.has("CALLER_UPDATE_DROPPED")) return respond(200, current)
	state.profiles.set(principal.token, next)
	return respond(200, next)
}

/** A project-scoped route: the caller and the project the path names, which must be theirs. */
export function ownProject(
	state: ReferenceState,
	request: ReferenceRequest,
	projectId: string,
): ReturnType<typeof authenticate> {
	const principal = authenticate(state, request)
	assertTenant(principal, projectId)
	return principal
}
