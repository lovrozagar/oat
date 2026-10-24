/** API keys: minted by a signed-in caller, bound to its tenant, rank and scopes, and revocable. */

import { createHmac } from "node:crypto"
import { HttpError } from "../errors.ts"
import type { ReferenceState } from "../state.ts"
import type { ApiKey, Principal } from "./types.ts"

/** What an operation asks of an API key: the scope it needs, and the tenant its path names, if any. */
export interface ApiKeyNeed {
	scope: string
	projectId?: string | number | undefined
}

/** A new key for `creator`, holding `scopes`, unnamed until its creator names it. */
export function createApiKey(state: ReferenceState, creator: Principal, scopes: readonly string[]): ApiKey {
	const { auth } = state
	auth.sequence += 1
	const id = `apikey_${String(auth.sequence).padStart(6, "0")}`
	const value = `ak_${createHmac("sha256", auth.secret).update(id).digest("hex").slice(0, 32)}`
	const key: ApiKey = {
		id,
		name: null,
		projectId: creator.projectId,
		rank: creator.rank,
		revoked: false,
		scopes: [...scopes],
		sub: creator.key,
		value,
	}
	auth.apiKeys.set(value, key)
	/* Every key the server issues is one it created, whoever asked for it. */
	state.ids.noteNamed("api-key", id)
	return key
}

/**
 * A live key of the caller's tenant by its id. A revoked key is gone, and another tenant's is as absent
 * as an unknown one: each is a 404.
 */
export function findApiKey(state: ReferenceState, caller: Principal, id: string): ApiKey {
	const key = [...state.auth.apiKeys.values()].find(
		(item) => item.id === id && item.projectId === caller.projectId && !item.revoked,
	)
	if (key === undefined) throw new HttpError(404, "not_found", `API key ${id} does not exist`)
	return key
}

/** Revokes a key of the caller's tenant; under KEY_DELETE_CROSS_TENANT, also a live key of another tenant. */
export function revokeApiKey(state: ReferenceState, caller: Principal, id: string): void {
	const anyTenant = [...state.auth.apiKeys.values()].find((item) => item.id === id && !item.revoked)
	const foreign = anyTenant !== undefined && anyTenant.projectId !== caller.projectId
	if (state.defects.has("KEY_DELETE_CROSS_TENANT") && foreign) anyTenant.revoked = true
	else ownedApiKey(state, caller, id).revoked = true
}

/* The tenant's admins rank 2: they manage every key of their tenant, as each creator manages its own. */
const ADMIN_RANK = 2

/** A live key of the caller's tenant that the caller may change: its own, or any when it is the tenant's admin. */
export function ownedApiKey(state: ReferenceState, caller: Principal, id: string): ApiKey {
	const key = findApiKey(state, caller, id)
	if (key.sub !== caller.key && caller.rank < ADMIN_RANK) {
		throw new HttpError(403, "forbidden", `API key ${id} is not the caller's to change`)
	}
	return key
}

/** The caller's tenant's live keys, in the order they were made. */
export function listApiKeys(state: ReferenceState, caller: Principal): ApiKey[] {
	return [...state.auth.apiKeys.values()].filter((item) => item.projectId === caller.projectId && !item.revoked)
}

/**
 * Who a live key authenticates as: its creator's rank, in its own tenant, for an operation it holds
 * the scope of. `need` is `undefined` where a jwt-only route lets keys in anyway.
 */
export function apiKeyPrincipal(state: ReferenceState, value: string, need: ApiKeyNeed | undefined): Principal {
	const { auth, defects } = state
	const key = auth.apiKeys.get(value)
	if (key === undefined) throw new HttpError(401, "unauthorized", "unknown API key")
	if ((key.revoked && !defects.has("REVOKED_TOKEN_ACCEPTED")) || auth.killed.has(key.sub)) {
		throw new HttpError(401, "unauthorized", "API key revoked")
	}
	let projectId = key.projectId
	const named = need?.projectId
	if (named !== undefined && named !== key.projectId) {
		if (!defects.has("CROSS_TENANT_KEY_ACCEPTED")) {
			throw new HttpError(403, "forbidden", "the API key belongs to another tenant")
		}
		projectId = String(named)
	}
	if (need !== undefined && !key.scopes.includes(need.scope) && !defects.has("SCOPE_NOT_CHECKED")) {
		throw new HttpError(403, "forbidden", `the API key lacks the scope "${need.scope}"`)
	}
	return { key: key.sub, projectId, rank: key.rank }
}
