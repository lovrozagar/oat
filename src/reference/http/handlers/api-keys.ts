/** Minting, reading and revoking API keys: a signed-in caller's, bound to its tenant, rank and the scopes it names. */

import { createApiKey, findApiKey, revokeApiKey } from "../auth/api-keys.ts"
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
	const scopes = (await readFields(request, state.defects, { scopes: "strings" }))["scopes"] as string[]
	const known = knownScopes(state)
	const unknown = scopes.find((scope) => !known.includes(scope))
	if (unknown !== undefined) throw new HttpError(400, "invalid_input", `unknown scope "${unknown}"`)
	const key = createApiKey(state, caller, scopes)
	return respond(201, { id: key.id, key: key.value })
}

const KEY = /^\/v1\/api-keys\/([^/]+)$/

/** `apiKey.get`: GET `/v1/api-keys/{id}`, a live key without its value, which only its create shows. */
export const readKey: Route = async (state, request) => {
	const match = KEY.exec(request.url.pathname)
	if (match === null || request.method !== "GET") return undefined
	const { id, scopes } = findApiKey(state, authenticate(state, request), match[1] as string)
	return respond(200, { id, scopes })
}

/** `apiKey.revoke`: DELETE `/v1/api-keys/{id}`. */
export const revokeKey: Route = async (state, request) => {
	const match = KEY.exec(request.url.pathname)
	if (match === null || request.method !== "DELETE") return undefined
	revokeApiKey(state, authenticate(state, request), match[1] as string)
	return respond(200, { revoked: true })
}
