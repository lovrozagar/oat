import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { bearerSecurity } from "../../src/conformance/harness/security.ts"
import type { PrincipalsConfig, SecurityConfig } from "../../src/config/types/security.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

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

function jsonContent(schema: Record<string, unknown>): Record<string, unknown> {
	return { "application/json": { schema } }
}

function inviteFlowPaths(): Record<string, unknown> {
	return {
		"/v1/invites/accept": {
			post: {
				operationId: "org.acceptInvite",
				requestBody: {
					content: jsonContent({ properties: { token: { type: "string" } }, required: ["token"], type: "object" }),
					required: true,
				},
				responses: {
					"200": {
						content: jsonContent({ properties: { access_token: { type: "string" } }, type: "object" }),
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
						content: jsonContent({ properties: { id: { type: "string" } }, required: ["id"], type: "object" }),
						description: "ok",
					},
				},
			},
		},
	}
}

function inviteMember(grants: string | undefined): Record<string, unknown> {
	return {
		operationId: "org.inviteMember",
		parameters: [ORG_PARAM],
		requestBody: {
			content: jsonContent({
				properties: { invite_email: { type: "string" } },
				required: ["invite_email"],
				type: "object",
			}),
			required: true,
		},
		responses: {
			"201": {
				content: jsonContent({
					properties: { id: { type: "string" }, invite_token: { type: "string" } },
					required: ["id", "invite_token"],
					type: "object",
				}),
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
	}
}

function memberPaths(grants: string | undefined): Record<string, unknown> {
	return {
		"/v1/orgs/{org_id}/members": {
			get: {
				operationId: "member.list",
				parameters: [ORG_PARAM],
				responses: {
					"200": {
						content: jsonContent({
							properties: { members: { items: MEMBER, type: "array" } },
							required: ["members"],
							type: "object",
						}),
						description: "ok",
					},
				},
				"x-entity": { action: "list", identity: "id", name: "member" },
			},
			post: inviteMember(grants),
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
				responses: { "200": { content: jsonContent(MEMBER), description: "ok" } },
				"x-entity": { action: "read", identity: "id", name: "member" },
			},
		},
	}
}

function spec(grants?: string): OpenApiDocument {
	return {
		...bearerSecurity(),
		info: { title: "invite-grants", version: "1" },
		openapi: "3.1.0",
		paths: { ...inviteFlowPaths(), ...memberPaths(grants) },
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

type OrgWorld = { deletes: string[]; document: OpenApiDocument; joined: boolean }

type OrgExchange = {
	auth: string
	match: RegExpExecArray
	member: boolean
	owner: boolean
	req: IncomingMessage
	res: ServerResponse
	world: OrgWorld
}

/* Matched in order; a route without a method answers every method. */
type OrgRoute = { handle: (exchange: OrgExchange) => unknown; method?: string; path: RegExp }

async function inviteToOrg({ owner, req, res }: OrgExchange): Promise<void> {
	if (!owner) return send(res, 403)
	await readJson(req)
	send(res, 201, { id: "m_beta", invite_token: "tok" })
}

async function acceptInvite({ auth, req, res, world }: OrgExchange): Promise<void> {
	const body = (await readJson(req)) as { token?: string } | undefined
	if (auth !== "Bearer b" || body?.token !== "tok") return send(res, 400)
	world.joined = true
	send(res, 200, { access_token: "b-joined" })
}

function readMember({ match, owner, res }: OrgExchange): void {
	if (!owner) return send(res, 403)
	if (match[1] === "m_owner") send(res, 200, { id: "m_owner" })
	else send(res, 404)
}

function removeMember({ match, owner, res, world }: OrgExchange): void {
	const item = match[1] ?? ""
	world.deletes.push(item)
	if (!owner) return send(res, 403)
	if (item === "m_owner") return send(res, 403, { error_key: "member_last_owner" })
	if (item === "m_beta") world.joined = false
	send(res, 204)
}

const ORG_ROUTES: readonly OrgRoute[] = [
	{ handle: ({ res, world }) => send(res, 200, world.document), path: /^\/v1\/openapi\/spec$/ },
	{ handle: ({ res }) => send(res, 200, { members: [] }), method: "GET", path: /^\/v1\/orgs\/org_2\/members$/ },
	{ handle: ({ res }) => send(res, 200, { id: "p_2" }), method: "GET", path: /^\/v1\/projects\/p_2\/tables$/ },
	{
		handle: ({ member, owner, res }) => (owner || member ? send(res, 200, { id: "p_1" }) : send(res, 403)),
		method: "GET",
		path: /^\/v1\/projects\/p_1\/tables$/,
	},
	/* Everything outside org_1 and the accept endpoint is unknown. */
	{ handle: ({ res }) => send(res, 404), path: /^(?!\/v1\/orgs\/org_1|\/v1\/invites\/accept$)/ },
	{
		handle: ({ owner, res }) =>
			owner ? send(res, 200, { members: [{ email: "alpha@x.test", id: "m_owner" }] }) : send(res, 403),
		method: "GET",
		path: /^\/v1\/orgs\/org_1\/members$/,
	},
	{ handle: inviteToOrg, method: "POST", path: /^\/v1\/orgs\/org_1\/members$/ },
	{ handle: acceptInvite, method: "POST", path: /^\/v1\/invites\/accept$/ },
	{ handle: readMember, method: "GET", path: /^\/v1\/orgs\/org_1\/members\/([^/]+)$/ },
	{ handle: removeMember, method: "DELETE", path: /^\/v1\/orgs\/org_1\/members\/([^/]+)$/ },
]

async function routeOrg(world: OrgWorld, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1")
	const method = (req.method ?? "GET").toUpperCase()
	const auth = req.headers.authorization ?? ""
	const exchange = {
		auth,
		member: auth === "Bearer b-joined" && world.joined,
		owner: auth === "Bearer a",
		req,
		res,
		world,
	}
	for (const route of ORG_ROUTES) {
		if (route.method !== undefined && route.method !== method) continue
		const match = route.path.exec(url.pathname)
		if (match !== null) {
			await route.handle({ ...exchange, match })
			return
		}
	}
	send(res, 404)
}

/**
 * org_1 (project p_1) belongs to alpha, org_2 (p_2) to beta. Beta joins org_1 by invite and then
 * reads p_1's tables with the token accept issued; its own p_2 is readable all along.
 */
async function orgServer(document: OpenApiDocument): Promise<{ deletes: string[]; url: string }> {
	const world: OrgWorld = { deletes: [], document, joined: false }
	const server = createServer((req, res) => {
		routeOrg(world, req, res).catch(() => {
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
	return { deletes: world.deletes, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

/* Each principal's bearer token is its `token`; beta's becomes the one accept issues once it joins. */
const security: SecurityConfig = { bearer: { static: "{principal.token}" } }
const principals: PrincipalsConfig = {
	alpha: { scope: { org_id: "org_1", project_id: "p_1" }, tenant: "org_1", token: "a" },
	beta: { inviteAs: "beta@x.test", scope: { org_id: "org_2", project_id: "p_2" }, tenant: "org_2", token: "b" },
}

describe("invite grants", () => {
	it("judges access by the read x-invite.grants names, filled from the inviter's scope", async () => {
		const server = await orgServer(spec("table.list"))
		const result = await run({
			baseUrl: server.url,
			only: ["member"],
			principals,
			security,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(result.checksRun).toContain("auth.invite-grants-then-revokes")
		expect(result.findings.filter((finding) => finding.check === "auth.invite-grants-then-revokes")).toEqual([])
		const reads = result.client.transcript.filter(
			(exchange) =>
				exchange.method === "GET" &&
				new URL(exchange.url).pathname === "/v1/projects/p_1/tables" &&
				exchange.principal !== "alpha",
		)
		expect(reads.map((exchange) => exchange.status)).toEqual([403, 403, 200, 403])
	})

	it("revokes the grant the invite returned, never the record the check read", async () => {
		const server = await orgServer(spec())
		await run({
			baseUrl: server.url,
			only: ["member"],
			principals,
			security,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(server.deletes).toContain("m_beta")
		expect(server.deletes).not.toContain("m_owner")
	})
})
