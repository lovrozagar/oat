/**
 * Fixture walk, cheap-profile effects, and invite/register-as-create contracts.
 *
 * These are the cases a real document trips: `z.unknown()` / `z.record` after `$ref` inlining,
 * `--profile cheap` still POSTing `extract.once`, and `org.inviteMember` / `auth.registerWithEmail`
 * being treated as `POST /things`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
	buildCohort,
	FixtureOverflow,
	generateBody,
	isOverflowError,
	mulberry32,
	overflowFrom,
} from "../runtime/fixture.ts"
import { codePointCount } from "../runtime/payloads.ts"
import { run } from "../runtime/run.ts"
import { buildModel } from "../spec/graph.ts"
import { dereference } from "../spec/load.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import type { ParserResult } from "./suite.ts"

function push(results: ParserResult[], name: string, why: string, ok: boolean, detail: string): void {
	results.push({ detail, name, ok, why })
}

export function runFixtureWalkCases(): ParserResult[] {
	const results: ParserResult[] = []

	try {
		const members = buildCohort(
			{
				properties: {
					columns: {
						items: {
							additionalProperties: {},
							default: {},
							properties: { name: { type: "string" } },
							required: ["name"],
							type: "object",
						},
						type: "array",
					},
				},
				required: ["columns"],
				type: "object",
			},
			1,
			["baseline"],
			"table.create",
		)
		const body = members[0]?.body
		push(
			results,
			"default: {} on a column object seeds",
			"z.unknown() / default: {} must not recurse",
			body !== undefined && Array.isArray(body.columns),
			body === undefined ? "threw or empty" : JSON.stringify(body).slice(0, 120),
		)
	} catch (error) {
		push(
			results,
			"default: {} on a column object seeds",
			"z.unknown() / default: {} must not recurse",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const cyclic: Record<string, unknown> = {
			properties: { child: { $ref: "#" } },
			type: "object",
		}
		const { doc } = dereference({
			components: { schemas: { Node: cyclic } },
			info: { title: "cycle", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/tables": {
					post: {
						operationId: "table.create",
						requestBody: {
							content: { "application/json": { schema: { $ref: "#" } } },
							required: true,
						},
						responses: { "201": { description: "ok" } },
						"x-entity": { action: "create", identity: "id", name: "table" },
					},
				},
			},
		} as OpenApiDocument)
		const schema = (
			doc.paths?.["/tables"] as { post?: { requestBody?: { content?: Record<string, { schema?: unknown }> } } }
		)?.post?.requestBody?.content?.["application/json"]?.schema as Record<string, unknown>
		const members = buildCohort(schema ?? {}, 1, ["baseline"], "table.create")
		push(
			results,
			"cyclic $ref: # after deref does not throw",
			"inlined identity cycles must terminate",
			members[0]?.body !== undefined,
			members[0] === undefined ? "empty" : "body returned",
		)
	} catch (error) {
		push(
			results,
			"cyclic $ref: # after deref does not throw",
			"inlined identity cycles must terminate",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const [member] = buildCohort(
			{
				properties: { email: { format: "email", type: "string" } },
				required: ["email"],
				type: "object",
			},
			1,
			["baseline"],
			"user.create",
		)
		const email = member?.body.email
		push(
			results,
			"format: email matches a conservative regex",
			"required email must not be Quarterly Report N",
			typeof email === "string" && /^[^@]+@[^@]+\.[^@]+$/.test(email),
			typeof email === "string" ? email : String(email),
		)
	} catch (error) {
		push(
			results,
			"format: email matches a conservative regex",
			"required email must not be Quarterly Report N",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const HANDLE = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
		const members = buildCohort(
			{
				properties: {
					handle: { maxLength: 32, minLength: 3, pattern: HANDLE, type: "string" },
					name: { maxLength: 32, minLength: 3, type: "string" },
				},
				required: ["handle", "name"],
				type: "object",
			},
			1,
			undefined,
			"user.create",
		)
		const re = new RegExp(HANDLE)
		const ok = members.every((member) => {
			const handle = member.body.handle
			const name = String(member.body.name ?? "")
			const n = codePointCount(name)
			return (
				typeof handle === "string" &&
				handle !== "a" &&
				re.test(handle) &&
				codePointCount(handle) >= 3 &&
				n >= 3 &&
				n <= 32
			)
		})
		push(
			results,
			"fixture strings honour minLength with pattern",
			"handle must not be a; every cohort name is in [3, 32]",
			ok,
			ok ? `${members.length} variants` : JSON.stringify(members.map((m) => m.body)),
		)
	} catch (error) {
		push(
			results,
			"fixture strings honour minLength with pattern",
			"handle must not be a; every cohort name is in [3, 32]",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const { body, missingRequired } = generateBody(
			{
				properties: {
					opt: { maxLength: 3, minLength: 10, type: "string" },
					req: { maxLength: 3, minLength: 10, type: "string" },
				},
				required: ["req"],
				type: "object",
			},
			"baseline",
			mulberry32(1),
			0,
			"thing.create",
		)
		const ok = body.opt === undefined && body.req === undefined && missingRequired.includes("/req")
		push(
			results,
			"minLength > maxLength is a generation gap",
			"omit optional; missingRequired on required; do not loop",
			ok,
			`body=${JSON.stringify(body)} missing=${missingRequired.join(",")}`,
		)
	} catch (error) {
		push(
			results,
			"minLength > maxLength is a generation gap",
			"omit optional; missingRequired on required; do not loop",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		overflowFrom(new RangeError("Maximum call stack size exceeded"), "table.create")
		const named = new FixtureOverflow("table.create", "/columns_json")
		push(
			results,
			"overflow names table.create, not unknown",
			"RangeError must become a named fixture gap",
			named.message.includes("table.create") && !named.message.includes("unknown") && isOverflowError(named),
			named.message,
		)
	} catch (error) {
		push(
			results,
			"overflow names table.create, not unknown",
			"RangeError must become a named fixture gap",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	return results
}

const PROJECT = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

function projectSpec(): OpenApiDocument {
	return {
		info: { title: "cheap-effects", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/projects": {
				get: {
					operationId: "project.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { projects: { items: PROJECT, type: "array" } },
										required: ["projects"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "project" },
				},
				post: {
					operationId: "project.create",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { name: { type: "string" } },
									required: ["name"],
									type: "object",
								},
							},
						},
						required: true,
					},
					responses: {
						"201": { content: { "application/json": { schema: PROJECT } }, description: "created" },
					},
					"x-entity": { action: "create", identity: "id", name: "project" },
				},
			},
			"/v1/projects/{project_id}": {
				get: {
					operationId: "project.read",
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": { content: { "application/json": { schema: PROJECT } }, description: "ok" },
					},
					"x-entity": { action: "read", identity: "id", name: "project" },
				},
			},
			"/v1/projects/{project_id}/extract": {
				post: {
					operationId: "extract.once",
					parameters: [{ in: "path", name: "project_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": { content: { "application/json": { schema: PROJECT } }, description: "ok" },
						"500": { description: "paid inference failed" },
					},
					"x-cost": "high",
					"x-effects": [{ entity: "project", op: "update" }],
					"x-entity": { action: "action", identity: "id", name: "project" },
				},
			},
		},
	} as OpenApiDocument
}

async function serveProject(): Promise<{ close: () => Promise<void>; url: string; extractHits: () => number }> {
	const spec = projectSpec()
	const rows = new Map<string, { id: string; name: string }>()
	let seq = 0
	let extractHits = 0
	const send = (res: ServerResponse, status: number, body?: unknown): void => {
		if (body === undefined) {
			res.writeHead(status)
			res.end()
			return
		}
		const text = JSON.stringify(body)
		res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
		res.end(text)
	}
	const readJson = (req: IncomingMessage): Promise<unknown> =>
		new Promise((resolve, reject) => {
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

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
			if (url.pathname === "/v1/projects" && method === "GET") return send(res, 200, { projects: [...rows.values()] })
			if (url.pathname === "/v1/projects" && method === "POST") {
				const body = (await readJson(req)) as { name?: unknown }
				const id = `p_${String((seq += 1))}`
				const row = { id, name: typeof body?.name === "string" ? body.name : "n" }
				rows.set(id, row)
				return send(res, 201, row)
			}
			const item = /^\/v1\/projects\/([^/]+)$/.exec(url.pathname)
			if (item !== null && method === "GET") {
				const row = rows.get(decodeURIComponent(item[1] ?? ""))
				return row === undefined ? send(res, 404) : send(res, 200, row)
			}
			const extract = /^\/v1\/projects\/([^/]+)\/extract$/.exec(url.pathname)
			if (extract !== null && method === "POST") {
				extractHits += 1
				return send(res, 500, { error: "paid inference" })
			}
			return send(res, 404)
		})().catch(() => {
			if (!res.headersSent) send(res, 500)
		})
	})
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		extractHits: () => extractHits,
		url: `http://127.0.0.1:${addr.port}`,
	}
}

function memberSpec(): OpenApiDocument {
	const member = {
		properties: { email: { format: "email", type: "string" }, id: { type: "string" } },
		required: ["id", "email"],
		type: "object",
	}
	return {
		info: { title: "invite-only", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/orgs/{org_id}/members": {
				get: {
					operationId: "member.list",
					parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { members: { items: member, type: "array" } },
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
					parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
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
					"x-invite": {
						accept: "invite.accept",
						grantPointer: "$.grant_id",
						granteeField: "invite_email",
						invite: "org.inviteMember",
						revoke: "invite.revoke",
						tokenPointer: "$.token",
					},
				},
			},
			"/v1/orgs/{org_id}/members/{member_id}": {
				get: {
					operationId: "member.read",
					parameters: [
						{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "member_id", required: true, schema: { type: "string" } },
					],
					responses: {
						"200": { content: { "application/json": { schema: member } }, description: "ok" },
					},
					"x-entity": { action: "read", identity: "id", name: "member" },
				},
			},
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
					parameters: [
						{ in: "path", name: "org_id", required: true, schema: { type: "string" } },
						{ in: "path", name: "grant_id", required: true, schema: { type: "string" } },
					],
					responses: { "200": { description: "ok" } },
					"x-entity": { action: "action", identity: "id", name: "member" },
				},
			},
		},
	} as OpenApiDocument
}

function userSpec(): OpenApiDocument {
	const user = {
		properties: { email: { format: "email", type: "string" }, id: { type: "string" } },
		required: ["id", "email"],
		type: "object",
	}
	return {
		info: { title: "register-is-not-seed", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/auth/register": {
				post: {
					operationId: "auth.registerWithEmail",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { email: { format: "email", type: "string" }, password: { type: "string" } },
									required: ["email", "password"],
									type: "object",
								},
							},
						},
						required: true,
					},
					responses: {
						"201": { content: { "application/json": { schema: user } }, description: "created" },
					},
					"x-entity": { action: "create", identity: "id", name: "user" },
					"x-fresh-principal": true,
				},
			},
			"/v1/auth/login": {
				post: {
					operationId: "auth.login",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { email: { type: "string" }, password: { type: "string" } },
									type: "object",
								},
							},
						},
					},
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { access_token: { type: "string" } },
										required: ["access_token"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
				},
			},
		},
	} as OpenApiDocument
}

function readJson(req: IncomingMessage): Promise<unknown> {
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

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
	res.end(text)
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
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

export async function runSeedContractSuite(): Promise<ParserResult[]> {
	const results = runFixtureWalkCases()

	const model = buildModel(dereference(memberSpec() as OpenApiDocument).doc)
	const member = model.entities.get("member")
	push(
		results,
		"invite op is not entity.create",
		"x-invite stays on entity.invite",
		member?.create === undefined && member?.invite !== null,
		`create=${member?.create ?? "none"} invite=${member?.invite?.invite ?? "none"}`,
	)

	try {
		const extracted: string[] = []
		const server = await serveProject()
		try {
			const cheap = await run({
				baseUrl: server.url,
				only: ["project"],
				principals: [{ headers: { authorization: "Bearer t" }, id: "alpha", roots: { project_id: "p_seed" } }],
				profile: "cheap",
				seed: 1,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const extractPosted = cheap.client.transcript.some((e) => e.url.includes("/extract"))
			const skip = cheap.findings.find((f) => f.check === "profile.skip" && f.detail.includes("x-cost: high"))
			push(
				results,
				"cheap profile does not POST extract.once",
				"effects must honour excludedByProfile",
				!extractPosted && skip !== undefined && server.extractHits() === 0,
				`hits=${server.extractHits()} skip=${skip?.detail ?? "none"}`,
			)
			extracted.push(...cheap.client.transcript.filter((e) => e.url.includes("/extract")).map((e) => e.url))
		} finally {
			await server.close()
		}

		const full = await serveProject()
		try {
			const result = await run({
				baseUrl: full.url,
				only: ["project"],
				principals: [{ headers: { authorization: "Bearer t" }, id: "alpha", roots: { project_id: "p_seed" } }],
				profile: "full",
				seed: 1,
				spec: `${full.url}/v1/openapi/spec`,
			})
			const extractPosted = result.client.transcript.some((e) => e.url.includes("/extract"))
			push(
				results,
				"full profile still invokes extract.once",
				"cheap is a restriction, not a deletion",
				extractPosted && full.extractHits() > 0,
				`hits=${full.extractHits()} posted=${extractPosted}`,
			)
			void extracted
		} finally {
			await full.close()
		}
	} catch (error) {
		push(
			results,
			"cheap profile does not POST extract.once",
			"effects must honour excludedByProfile",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const seedBodies: unknown[] = []
		const inviteBodies: unknown[] = []
		const spec = memberSpec()
		const members = new Map<string, { email: string; id: string }>()
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
				if (url.pathname === "/v1/orgs/org_1/members" && method === "GET") {
					return send(res, 200, { members: [...members.values()] })
				}
				if (url.pathname === "/v1/orgs/org_1/members" && method === "POST") {
					const body = await readJson(req)
					inviteBodies.push(body)
					if (
						body !== null &&
						typeof body === "object" &&
						"invite_email" in body &&
						typeof (body as { invite_email: unknown }).invite_email === "string" &&
						!(body as { invite_email: string }).invite_email.includes("@")
					) {
						seedBodies.push(body)
						return send(res, 400, { error: "invalid email" })
					}
					return send(res, 201, { grant_id: "g1", token: "tok" })
				}
				if (url.pathname === "/v1/invites/tok/accept" && method === "POST") return send(res, 200, { ok: true })
				if (url.pathname === "/v1/orgs/org_1/grants/g1" && method === "DELETE") return send(res, 200, { ok: true })
				const item = /^\/v1\/orgs\/org_1\/members\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET") return send(res, 404)
				return send(res, 404)
			})().catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		try {
			const result = await run({
				baseUrl: server.url,
				only: ["member"],
				principals: [
					{ headers: { authorization: "Bearer a" }, id: "alpha", roots: { org_id: "org_1" } },
					{
						headers: { authorization: "Bearer b" },
						id: "beta",
						inviteAs: "beta@x.test",
						roots: { org_id: "org_2" },
					},
				],
				seed: 1,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const inviteWithPeer = inviteBodies.some(
				(body) =>
					body !== null &&
					typeof body === "object" &&
					(body as { invite_email?: unknown }).invite_email === "beta@x.test",
			)
			const generated = seedBodies.length > 0
			const ran = result.checksRun.includes("auth.invite-grants-then-revokes")
			push(
				results,
				"invite-only member is not seeded with a generated email",
				"invite check sends inviteAs",
				!generated && inviteWithPeer && ran,
				`seedJunk=${generated} inviteAsSent=${inviteWithPeer} ran=${ran} bodies=${JSON.stringify(inviteBodies)}`,
			)
		} finally {
			await server.close()
		}
	} catch (error) {
		push(
			results,
			"invite-only member is not seeded with a generated email",
			"invite check sends inviteAs",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	try {
		const registerFrom: string[] = []
		const spec = userSpec()
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
				if (url.pathname === "/v1/auth/register" && method === "POST") {
					const via = req.headers["x-via"] === "auth" ? "auth" : "other"
					registerFrom.push(via)
					const body = (await readJson(req)) as { email?: unknown }
					if (typeof body?.email === "string" && !body.email.includes("@")) {
						return send(res, 400, { error: "invalid email" })
					}
					return send(res, 201, { email: body?.email, id: "u1" })
				}
				if (url.pathname === "/v1/auth/login" && method === "POST") {
					return send(res, 200, { access_token: "tok" })
				}
				return send(res, 404)
			})().catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		try {
			await run({
				baseUrl: server.url,
				only: ["user"],
				principals: [
					{
						auth: {
							credentialFrom: "$.access_token",
							steps: [
								{
									body: { email: "alpha@x.test", password: "pw" },
									headers: { "x-via": "auth" },
									operationId: "auth.registerWithEmail",
								},
								{ body: { email: "alpha@x.test", password: "pw" }, operationId: "auth.login" },
							],
						},
						id: "alpha",
					},
				],
				seed: 1,
				spec: `${server.url}/v1/openapi/spec`,
			})
			push(
				results,
				"auth.registerWithEmail is not seeded",
				"auth-flow creates are provisioned, not fixtures",
				registerFrom.length === 1 && registerFrom[0] === "auth",
				`register calls=${registerFrom.join(",") || "none"}`,
			)
		} finally {
			await server.close()
		}
	} catch (error) {
		push(
			results,
			"auth.registerWithEmail is not seeded",
			"auth-flow creates are provisioned, not fixtures",
			false,
			error instanceof Error ? error.message : String(error),
		)
	}

	return results
}
