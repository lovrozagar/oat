/** One request in, one answer out: the fixed routes in order, then the entity model's. */

import { SAFE } from "../../spec/methods.ts"
import { assertParents, assertTenant } from "./access.ts"
import { authenticate } from "./auth/credentials.ts"
import { errorResponse, HttpError } from "./errors.ts"
import { inbox, notify, startJob } from "./handlers/actions.ts"
import { create } from "./handlers/create.ts"
import type { ItemCall } from "./handlers/entity.ts"
import { createKey, readKey, revokeKey } from "./handlers/api-keys.ts"
import { deleteAccount, deleteSelf, login, logout, refresh, register, revokeToken, token } from "./handlers/auth.ts"
import { account, document, health, me, notices, overview, type Route } from "./handlers/fixed.ts"
import { accept, invite, revoke } from "./handlers/grants.ts"
import { read, remove, update } from "./handlers/item.ts"
import { list } from "./handlers/list.ts"
import { search } from "./handlers/query-route.ts"
import { styles } from "./handlers/styles.ts"
import { matchRoute } from "./routes.ts"
import type { ReferenceState } from "./state.ts"
import { advanceJobs, typedScope } from "./store-ops.ts"
import type { ReferenceRequest, ReferenceResponse } from "./wire.ts"

/* In the order they are tried: an earlier route shadows a later one. */
const FIXED: readonly Route[] = [
	document,
	token,
	login,
	refresh,
	revokeToken,
	createKey,
	readKey,
	revokeKey,
	startJob,
	notify,
	inbox,
	invite,
	accept,
	revoke,
	health,
	notices,
	register,
	logout,
	deleteSelf,
	deleteAccount,
	overview,
	me,
	account,
	styles,
	search,
]

/** The answer to `request`; a refusal or failure is an answer too. */
export async function handle(state: ReferenceState, request: ReferenceRequest): Promise<ReferenceResponse> {
	try {
		return await route(state, request)
	} catch (error) {
		return errorResponse(error, state.defects)
	}
}

async function route(state: ReferenceState, request: ReferenceRequest): Promise<ReferenceResponse> {
	const { url } = request
	/* Mounted under a prefix, the API exists only there. */
	if (state.basePath !== "") {
		if (url.pathname !== state.basePath && !url.pathname.startsWith(`${state.basePath}/`)) {
			throw new HttpError(404, "not_found", `no route for ${url.pathname}`)
		}
		url.pathname = url.pathname.slice(state.basePath.length) || "/"
	}
	for (const fixed of FIXED) {
		const answer = await fixed(state, request)
		if (answer !== undefined) return answer
	}
	return entityRoute(state, request)
}

async function entityRoute(state: ReferenceState, request: ReferenceRequest): Promise<ReferenceResponse> {
	const { method, url } = request
	const match = matchRoute(url.pathname, state.entities)
	if (match === null) throw new HttpError(404, "not_found", `no route for ${url.pathname}`)
	const { entity } = match
	/* A record route takes a bearer JWT, or an API key holding the entity's read or write scope. */
	const access = SAFE.has(method) ? "read" : "write"
	const principal = authenticate(state, request, {
		projectId: match.scope["project_id"],
		scope: `${entity.name}:${access}`,
	})
	const scope = await typedScope(state, match.scope)
	const itemId = match.itemId === null ? null : (scope[entity.itemParam] as string | number)
	const call = { entity, principal, scope }
	/* Item GET may be a delegated read — a tenant check would 403 a valid grant before the lookup
	 * can honour it. Collection GET and mutations stay tenant-bound. */
	if (method !== "GET" || itemId === null) {
		assertTenant(principal, scope["project_id"])
		await assertParents(state, call)
	}
	if (entity.name === state.job.name && method === "GET") await advanceJobs(state)
	if (itemId === null) {
		if (method === "GET") return list(state, request, call)
		if (method === "POST") return create(state, request, call)
		throw new HttpError(404, "not_found", `method ${method} not supported here`)
	}
	return item(state, request, { ...call, itemId })
}

function item(state: ReferenceState, request: ReferenceRequest, call: ItemCall): Promise<ReferenceResponse> {
	if (request.method === "GET") return read(state, call)
	if (request.method === state.updateMethod) return update(state, request, call)
	if (request.method === "DELETE") return remove(state, call)
	throw new HttpError(405, "method_not_allowed", `method ${request.method} not supported`)
}
