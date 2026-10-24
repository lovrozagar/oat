/** Minting, reading and revoking API keys: a signed-in caller's, bound to its tenant, rank and the scopes it names. */

import type { ApiKey } from "../auth/types.ts"
import { createApiKey, findApiKey, listApiKeys, ownedApiKey, revokeApiKey } from "../auth/api-keys.ts"
import { authenticate } from "../auth/credentials.ts"
import { readFields } from "../body.ts"
import { HttpError } from "../errors.ts"
import type { ReferenceState } from "../state.ts"
import { respond } from "../wire.ts"
import type { Route } from "./fixed.ts"

/** Every scope a key may hold: reading or writing each entity. */
export function knownScopes(state: ReferenceState): string[] {
	return state.entities.flatMap((entity) => [`${entity.name}:read`, `${entity.name}:write`])
}

/** `apiKey.create { scopes }`: a new key, answered once with its value. */
export const createKey: Route = async (state, request) => {
	if (request.method !== "POST" || request.url.pathname !== "/v1/api-keys") return undefined
	const caller = authenticate(state, request)
	const kinds = state.shape.keyLifecycle === true ? { name: "string?", scopes: "strings" } : { scopes: "strings" }
	const fields = await readFields(request, state.defects, kinds as Record<string, "string?" | "strings">)
	const scopes = fields["scopes"] as string[]
	const known = knownScopes(state)
	const unknown = scopes.find((scope) => !known.includes(scope))
	if (unknown !== undefined) throw new HttpError(400, "invalid_input", `unknown scope "${unknown}"`)
	const key = createApiKey(state, caller, scopes)
	key.name = (fields["name"] as string | undefined) ?? null
	return respond(201, { id: key.id, key: key.value })
}

const KEY = /^\/v1\/api-keys\/([^/]+)$/

/** `apiKey.get`: GET `/v1/api-keys/{id}`, a live key without its value, which only its create shows. */
export const readKey: Route = async (state, request) => {
	const match = KEY.exec(request.url.pathname)
	if (match === null || request.method !== "GET") return undefined
	return respond(200, shown(state, findApiKey(state, authenticate(state, request), match[1] as string)))
}

/* A key as it is read back, never with its value: named behind key-lifecycle. */
function shown(state: ReferenceState, key: ApiKey): Record<string, unknown> {
	const { id, name, scopes } = key
	return state.shape.keyLifecycle === true ? { id, name, scopes } : { id, scopes }
}

/** `apiKey.list` behind key-lifecycle: GET `/v1/api-keys`, the caller's tenant's live keys. */
export const listKeys: Route = async (state, request) => {
	if (state.shape.keyLifecycle !== true || request.method !== "GET" || request.url.pathname !== "/v1/api-keys") {
		return undefined
	}
	return respond(
		200,
		listApiKeys(state, authenticate(state, request)).map((key) => shown(state, key)),
	)
}

/** `apiKey.update` behind key-lifecycle: PATCH `/v1/api-keys/{id}` `{ name }`, a key of the caller's tenant. */
export const renameKey: Route = async (state, request) => {
	const match = KEY.exec(request.url.pathname)
	if (state.shape.keyLifecycle !== true || match === null || request.method !== "PATCH") return undefined
	const key = ownedApiKey(state, authenticate(state, request), match[1] as string)
	key.name = (await readFields(request, state.defects, { name: "string" }))["name"] as string
	return respond(200, shown(state, key))
}

/** `apiKey.revoke`: DELETE `/v1/api-keys/{id}`. */
export const revokeKey: Route = async (state, request) => {
	const match = KEY.exec(request.url.pathname)
	if (match === null || request.method !== "DELETE") return undefined
	revokeApiKey(state, authenticate(state, request), match[1] as string)
	return respond(200, { revoked: true })
}
