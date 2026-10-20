/**
 * An invite-only member API: `org.inviteMember` is how a member comes to exist, so it must stay
 * on `entity.invite` and never be seeded as `POST /things` with a generated email.
 */

import type { Handle } from "../../reference/http/node.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { bearerSecurity } from "../harness/security.ts"
import { answer, guarded, readJson } from "../harness/serve.ts"

const MEMBER = {
	properties: { email: { format: "email", type: "string" }, id: { type: "string" } },
	required: ["id", "email"],
	type: "object",
}

const ORG_ID = { in: "path", name: "org_id", required: true, schema: { type: "string" } }

function list(): Record<string, unknown> {
	return {
		operationId: "member.list",
		parameters: [ORG_ID],
		responses: {
			"200": {
				content: {
					"application/json": {
						schema: {
							properties: { members: { items: MEMBER, type: "array" } },
							required: ["members"],
							type: "object",
						},
					},
				},
				description: "ok",
			},
		},
		"x-entity": { action: "list", identity: "id", name: "member" },
	}
}

const INVITE = {
	accept: "invite.accept",
	grantPointer: "$.grant_id",
	granteeField: "invite_email",
	invite: "org.inviteMember",
	revoke: "invite.revoke",
	tokenPointer: "$.token",
}

function invite(): Record<string, unknown> {
	return {
		operationId: "org.inviteMember",
		parameters: [ORG_ID],
		requestBody: {
			content: {
				"application/json": {
					schema: {
						properties: { invite_email: { format: "email", type: "string" } },
						required: ["invite_email"],
						type: "object",
					},
				},
			},
			required: true,
		},
		responses: {
			"201": {
				content: {
					"application/json": {
						schema: {
							properties: { grant_id: { type: "string" }, token: { type: "string" } },
							required: ["grant_id", "token"],
							type: "object",
						},
					},
				},
				description: "invited",
			},
		},
		"x-entity": { action: "create", identity: "id", name: "member" },
		"x-invite": INVITE,
	}
}

/* The invite's accept and revoke steps. */
function grantPaths(): Record<string, unknown> {
	return {
		"/v1/invites/{token}/accept": {
			post: {
				operationId: "invite.accept",
				parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
				"x-entity": { action: "action", identity: "id", name: "member" },
			},
		},
		"/v1/orgs/{org_id}/grants/{grant_id}": {
			delete: {
				operationId: "invite.revoke",
				parameters: [ORG_ID, { in: "path", name: "grant_id", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
				"x-entity": { action: "action", identity: "id", name: "member" },
			},
		},
	}
}

export function memberSpec(): OpenApiDocument {
	return {
		info: { title: "invite-only", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/orgs/{org_id}/members": { get: list(), post: invite() },
			"/v1/orgs/{org_id}/members/{member_id}": {
				get: {
					operationId: "member.read",
					parameters: [ORG_ID, { in: "path", name: "member_id", required: true, schema: { type: "string" } }],
					responses: { "200": { content: { "application/json": { schema: MEMBER } }, description: "ok" } },
					"x-entity": { action: "read", identity: "id", name: "member" },
				},
			},
			...grantPaths(),
		},
		...bearerSecurity(),
	} as OpenApiDocument
}

/** The member API, every invite body it was sent, and the ones a seed sent with a generated email. */
export interface MemberBackend {
	handle: Handle
	inviteBodies: unknown[]
	seedBodies: unknown[]
}

export function memberBackend(): MemberBackend {
	const spec = memberSpec()
	const inviteBodies: unknown[] = []
	const seedBodies: unknown[] = []
	const handle: Handle = async (request) => {
		const { pathname } = request.url
		const { method } = request
		if (pathname === "/v1/openapi/spec" && method === "GET") return answer(200, spec)
		if (pathname === "/v1/orgs/org_1/members" && method === "GET") return answer(200, { members: [] })
		if (pathname === "/v1/orgs/org_1/members" && method === "POST") {
			const body = await readJson(request)
			inviteBodies.push(body)
			const email = (body as { invite_email?: unknown } | null | undefined)?.invite_email
			if (typeof email === "string" && !email.includes("@")) {
				seedBodies.push(body)
				return answer(400, { error: "invalid email" })
			}
			return answer(201, { grant_id: "g1", token: "tok" })
		}
		if (pathname === "/v1/invites/tok/accept" && method === "POST") return answer(200, { ok: true })
		if (pathname === "/v1/orgs/org_1/grants/g1" && method === "DELETE") return answer(200, { ok: true })
		return answer(404)
	}
	return { handle: guarded(handle), inviteBodies, seedBodies }
}
