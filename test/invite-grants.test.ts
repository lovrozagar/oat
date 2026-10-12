import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * An organization invite opens the organization, not the member records: a plain member reads the
 * organization but cannot read another member. The grant id is the new membership, which is also
 * what revoke removes, never the owner's membership the check happened to list first.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const MEMBER = {
	properties: { email: { type: "string" }, id: { type: "string" } },
	required: ["id"],
	type: "object",
}
const ORG_PARAM = { in: "path", name: "org_id", required: true, schema: { type: "string" } }
const MEMBER_PARAM = { in: "path", name: "member_id", required: true, schema: { type: "string" } }

function spec(grants?: string): OpenApiDocument {
	return {
		info: { title: "invite-grants", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/invites/accept": {
				post: {
					operationId: "org.acceptInvite",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { token: { type: "string" } }, required: ["token"], type: "object" },
							},
						},
						required: true,
					},
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { properties: { access_token: { type: "string" } }, type: "object" },
								},
							},
							description: "ok",
						},
					},
				},
			},
			"/v1/projects/{project_id}/tables": {
				get: {
					operationId: "table.list",
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
								},
							},
							description: "ok",
						},
					},
				},
			},
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
				post: {
					operationId: "org.inviteMember",
					parameters: [ORG_PARAM],
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { invite_email: { type: "string" } },
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
										properties: { id: { type: "string" }, invite_token: { type: "string" } },
										required: ["id", "invite_token"],
										type: "object",
									},
								},
							},
							description: "invited",
						},
					},
					"x-invite": {
						accept: "org.acceptInvite",
						grantPointer: "$.id",
						granteeField: "invite_email",
						invite: "org.inviteMember",
						revoke: "org.removeMember",
						tokenPointer: "$.invite_token",
						...(grants === undefined ? {} : { grants }),
					},
				},
			},
			"/v1/orgs/{org_id}/members/{member_id}": {
				delete: {
					operationId: "org.removeMember",
					parameters: [ORG_PARAM, MEMBER_PARAM],
					responses: { "204": { description: "removed" } },
					"x-entity": { action: "delete", identity: "id", name: "member" },
				},
				get: {
					operationId: "member.read",
					parameters: [ORG_PARAM, MEMBER_PARAM],
					responses: { "200": { content: { "application/json": { schema: MEMBER } }, description: "ok" } },
					"x-entity": { action: "read", identity: "id", name: "member" },
				},
			},
		},
	} as OpenApiDocument
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	const text = body === undefined ? "" : JSON.stringify(body)
	res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
	res.end(text)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const text = Buffer.concat(chunks).toString("utf8")
	return text === "" ? undefined : (JSON.parse(text) as unknown)
}

/**
 * org_1 (project p_1) belongs to alpha, org_2 (p_2) to beta. Beta joins org_1 by invite and then
 * reads p_1's tables with the token accept issued; its own p_2 is readable all along.
 */
async function orgServer(document: OpenApiDocument): Promise<{ deletes: string[]; url: string }> {
	const deletes: string[] = []
	let joined = false
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			const auth = req.headers.authorization ?? ""
			const owner = auth === "Bearer a"
			const member = auth === "Bearer b-joined" && joined
			if (url.pathname === "/v1/openapi/spec") return send(res, 200, document)
			if (url.pathname === "/v1/orgs/org_2/members" && method === "GET") return send(res, 200, { members: [] })
			if (url.pathname === "/v1/projects/p_2/tables" && method === "GET") return send(res, 200, { id: "p_2" })
			if (url.pathname === "/v1/projects/p_1/tables" && method === "GET") {
				return owner || member ? send(res, 200, { id: "p_1" }) : send(res, 403)
			}
			if (!url.pathname.startsWith("/v1/orgs/org_1") && url.pathname !== "/v1/invites/accept") return send(res, 404)
			if (url.pathname === "/v1/orgs/org_1/members" && method === "GET") {
				return owner ? send(res, 200, { members: [{ email: "alpha@x.test", id: "m_owner" }] }) : send(res, 403)
			}
			if (url.pathname === "/v1/orgs/org_1/members" && method === "POST") {
				if (!owner) return send(res, 403)
				await readJson(req)
				return send(res, 201, { id: "m_beta", invite_token: "tok" })
			}
			if (url.pathname === "/v1/invites/accept" && method === "POST") {
				const body = (await readJson(req)) as { token?: string } | undefined
				if (auth !== "Bearer b" || body?.token !== "tok") return send(res, 400)
				joined = true
				return send(res, 200, { access_token: "b-joined" })
			}
			const item = /^\/v1\/orgs\/org_1\/members\/([^/]+)$/.exec(url.pathname)?.[1]
			if (item !== undefined && method === "GET") {
				if (!owner) return send(res, 403)
				return item === "m_owner" ? send(res, 200, { id: "m_owner" }) : send(res, 404)
			}
			if (item !== undefined && method === "DELETE") {
				deletes.push(item)
				if (!owner) return send(res, 403)
				if (item === "m_owner") return send(res, 403, { error_key: "member_last_owner" })
				if (item === "m_beta") joined = false
				return send(res, 204)
			}
			return send(res, 404)
		})().catch(() => {
			if (!res.headersSent) send(res, 500)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(
		() =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
	)
	return { deletes, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const principals = [
	{ headers: { authorization: "Bearer a" }, id: "alpha", roots: { org_id: "org_1", project_id: "p_1" } },
	{
		headers: { authorization: "Bearer b" },
		id: "beta",
		inviteAs: "beta@x.test",
		roots: { org_id: "org_2", project_id: "p_2" },
	},
]

describe("invite grants", () => {
	it("judges access by the read x-invite.grants names, filled from the inviter's scope", async () => {
		const server = await orgServer(spec("table.list"))
		const result = await run({
			baseUrl: server.url,
			only: ["member"],
			principals,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
		expect(result.findings.filter((finding) => finding.check === "auth.invite-grants-then-revokes")).toEqual([])
		const reads = result.client.transcript.filter(
			(exchange) =>
				exchange.method === "GET" &&
				new URL(exchange.url).pathname === "/v1/projects/p_1/tables" &&
				exchange.requestHeaders.authorization !== "Bearer a",
		)
		expect(reads.map((exchange) => exchange.status)).toEqual([403, 403, 200, 403])
	})

	it("revokes the grant the invite returned, never the record the check read", async () => {
		const server = await orgServer(spec())
		await run({
			baseUrl: server.url,
			only: ["member"],
			principals,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(server.deletes).toContain("m_beta")
		expect(server.deletes).not.toContain("m_owner")
	})
})
