/** Sharing a table with another principal: invite, accept, revoke. */

import { assertTenant, assertWrite, authenticate, findItem } from "../access.ts"
import { readJson, requireJson } from "../body.ts"
import { HttpError } from "../errors.ts"
import { type Grant, PRINCIPALS } from "../state.ts"
import { tableByKey } from "../store-ops.ts"
import { respond } from "../wire.ts"
import type { Route } from "./fixed.ts"

export const invite: Route = async (state, request) => {
	const match = /^\/v1\/projects\/([^/]+)\/tables\/([^/]+)\/invites$/.exec(request.url.pathname)
	if (match === null || request.method !== "POST") return undefined
	const principal = authenticate(state, request)
	const projectId = match[1] as string
	const tableId = await tableByKey(state, projectId, match[2] as string)
	assertTenant(principal, projectId)
	assertWrite(state, principal, "create")
	requireJson(request, state.defects)
	const key = ((await readJson(request)) as { key?: unknown }).key
	if (typeof key !== "string" || key === "") throw new HttpError(400, "invalid_input", 'field "key" is required')
	if (PRINCIPALS.find((p) => p.key === key) === undefined)
		throw new HttpError(400, "invalid_input", "unknown invitee key")
	await findItem(state, { entity: state.table, itemId: tableId, principal, scope: { project_id: projectId } })
	const grant: Grant = {
		accepted: false,
		entity: "table",
		grantId: `grn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
		granteeKey: key,
		resourceId: String(tableId),
		token: `inv_${Math.random().toString(36).slice(2, 12)}`,
	}
	state.grants.set(grant.grantId, grant)
	return respond(201, { grant_id: grant.grantId, token: grant.token })
}

export const accept: Route = async (state, request) => {
	const match = /^\/v1\/invites\/([^/]+)\/accept$/.exec(request.url.pathname)
	if (match === null || request.method !== "POST") return undefined
	const principal = authenticate(state, request)
	const grant = [...state.grants.values()].find((item) => item.token === (match[1] as string))
	if (grant === undefined) throw new HttpError(404, "not_found", "invite not found")
	if (grant.granteeKey !== principal.key) throw new HttpError(403, "forbidden", "invite is not for this principal")
	grant.accepted = true
	return respond(200, { accepted: true })
}

export const revoke: Route = async (state, request) => {
	const match = /^\/v1\/projects\/([^/]+)\/tables\/([^/]+)\/grants\/([^/]+)$/.exec(request.url.pathname)
	if (match === null || request.method !== "DELETE") return undefined
	const principal = authenticate(state, request)
	const projectId = match[1] as string
	const tableId = String(await tableByKey(state, projectId, match[2] as string))
	assertTenant(principal, projectId)
	assertWrite(state, principal, "delete")
	const grant = state.grants.get(match[3] as string)
	if (grant === undefined || grant.resourceId !== tableId) throw new HttpError(404, "not_found", "grant not found")
	if (!state.defects.has("REVOKE_IGNORED")) state.grants.delete(grant.grantId)
	return respond(200, { revoked: true })
}
