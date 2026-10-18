import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/* The invite world of tests/integration/invite-accept.test.ts: its spec and a route-table server. */

export const MEMBER = {
	properties: { email: { format: "email", type: "string" }, id: { type: "string" } },
	required: ["id", "email"],
	type: "object",
}

export function jsonBody(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
	return {
		content: { "application/json": { schema: { properties, required, type: "object" } } },
		required: true,
	}
}

export const ACTION = { action: "action", identity: "id", name: "member" }

export function acceptPath(accept: "body" | "path"): Record<string, unknown> {
	if (accept === "body") {
		return {
			"/v1/invites/accept": {
				post: {
					operationId: "invite.accept",
					requestBody: jsonBody({ token: { type: "string" } }, ["token"]),
					responses: { "200": { description: "ok" } },
					"x-entity": ACTION,
				},
			},
		}
	}
	return {
		"/v1/invites/{token}": {
			post: {
				operationId: "invite.accept",
				parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
				"x-entity": ACTION,
			},
		},
	}
}

export function revokePath(revoke: "body" | "path"): Record<string, unknown> {
	if (revoke === "body") {
		return {
			"/v1/invites/revoke": {
				post: {
					operationId: "invite.revoke",
					requestBody: jsonBody({ grant_id: { type: "string" } }, ["grant_id"]),
					responses: { "200": { description: "ok" } },
					"x-entity": ACTION,
				},
			},
		}
	}
	return {
		"/v1/orgs/{org_id}/grants/{grant_id}": {
			delete: {
				operationId: "invite.revoke",
				parameters: [
					{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
					{ in: "path", name: "grant_id", required: true, schema: { type: "string" } },
				],
				responses: { "200": { description: "ok" } },
				"x-entity": ACTION,
			},
		},
	}
}

export const ORG_PARAM = { in: "path", name: "org_id", required: true, schema: { type: "string" } }

export function inviteMember(): Record<string, unknown> {
	return {
		operationId: "org.inviteMember",
		parameters: [ORG_PARAM],
		requestBody: jsonBody({ invite_email: { format: "email", type: "string" } }, ["invite_email"]),
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
		"x-invite": {
			accept: "invite.accept",
			grantPointer: "$.grant_id",
			granteeField: "invite_email",
			invite: "org.inviteMember",
			revoke: "invite.revoke",
			tokenPointer: "$.token",
		},
	}
}

export function memberPaths(): Record<string, unknown> {
	return {
		"/v1/orgs/{org_id}/members": {
			get: {
				operationId: "member.list",
				parameters: [ORG_PARAM],
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
			},
			post: inviteMember(),
		},
		"/v1/orgs/{org_id}/members/{member_id}": {
			get: {
				operationId: "member.read",
				parameters: [ORG_PARAM, { in: "path", name: "member_id", required: true, schema: { type: "string" } }],
				responses: { "200": { content: { "application/json": { schema: MEMBER } }, description: "ok" } },
				"x-entity": { action: "read", identity: "id", name: "member" },
			},
		},
	}
}

export function inviteSpec(accept: "body" | "path", revoke: "body" | "path" = "path"): OpenApiDocument {
	return {
		info: { title: "invite-accept", version: "1" },
		openapi: "3.1.0",
		paths: { ...memberPaths(), ...acceptPath(accept), ...revokePath(revoke) },
	} as OpenApiDocument
}

/** The body spec with its x-invite extension extended by `extra`. */
export function inviteSpecWith(extra: Record<string, unknown>): OpenApiDocument {
	const spec = inviteSpec("body")
	const invite = spec.paths?.["/v1/orgs/{org_id}/members"]?.post as Record<string, unknown>
	invite["x-invite"] = { ...(invite["x-invite"] as Record<string, unknown>), ...extra }
	return spec
}

export function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
		})
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			if (text === "") {
				resolve(undefined)
				return
			}
			try {
				resolve(JSON.parse(text) as unknown)
			} catch (error) {
				reject(error)
			}
		})
		req.on("error", reject)
	})
}

export function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
	res.end(text)
}

export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
	close: () => Promise<void>
	url: string
}> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
}

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => unknown
/** One route of a fake world: method, exact pathname, and its handler. */
export type Route = readonly [method: string, path: string, handle: Handler]

export async function dispatch(routes: readonly Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1")
	const method = (req.method ?? "GET").toUpperCase()
	const route = routes.find(([m, path]) => m === method && path === url.pathname)
	if (route === undefined) return send(res, 404)
	await route[2](req, res, url)
}
