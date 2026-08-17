import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { createPrincipal, resolveOutOfBandValue, resolvePrincipalAuthValue } from "../src/runtime/auth.ts"
import { Client } from "../src/runtime/client.ts"
import { run } from "../src/runtime/run.ts"
import { isAuthFlow, isHookAuth } from "../src/config/define-config.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

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

const AUTH_SPEC = {
	info: { title: "hooks", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/auth/register": {
			post: {
				operationId: "auth.register",
				requestBody: { content: { "application/json": { schema: { type: "object" } } } },
				responses: { "200": { description: "ok" } },
			},
		},
		"/v1/items": {
			get: { operationId: "item.list", responses: { "200": { description: "ok" } } },
		},
	},
} as OpenApiDocument

describe("resolveOutOfBand backoff", () => {
	it("requires the hook and retries null / empty", async () => {
		await expect(
			resolveOutOfBandValue(undefined, "a@x.test", "email-verify", { label: 'principal "a"' }),
		).rejects.toThrow(/no resolveOutOfBand hook/)

		let n = 0
		const value = await resolveOutOfBandValue(
			async ({ attempt, kind, address }) => {
				expect(kind).toBe("email-verify")
				expect(address).toBe("a@x.test")
				n = attempt
				return attempt < 3 ? (attempt === 1 ? null : "") : "tok"
			},
			"a@x.test",
			"email-verify",
			{ label: 'principal "a"', outOfBand: { attempts: 4, initialMs: 1, maxMs: 1 } },
		)
		expect(value).toBe("tok")
		expect(n).toBe(3)

		await expect(
			resolveOutOfBandValue(async () => null, "a@x.test", "email-verify", {
				label: 'principal "a"',
				outOfBand: { attempts: 2, initialMs: 1, maxMs: 1 },
			}),
		).rejects.toThrow(/after 2 attempts/)
	})
})

describe("resolvePrincipalAuth / fromHook", () => {
	it("distinguishes hook auth from a step chain", () => {
		expect(isHookAuth({ fromHook: "oauth-google" })).toBe(true)
		expect(isAuthFlow({ fromHook: "oauth-google" })).toBe(false)
		expect(isHookAuth({ credentialFrom: "$.t", steps: [{ method: "POST", path: "/x" }] })).toBe(false)
		expect(isAuthFlow({ credentialFrom: "$.t", steps: [{ method: "POST", path: "/x" }] })).toBe(true)
	})

	it("requires the hook and retries null", async () => {
		await expect(resolvePrincipalAuthValue(undefined, "oauth-google", { label: 'principal "g"' })).rejects.toThrow(
			/no resolvePrincipalAuth hook/,
		)

		await expect(
			resolvePrincipalAuthValue(async () => null, "oauth-google", {
				label: 'principal "g"',
				outOfBand: { attempts: 2, initialMs: 1, maxMs: 1 },
			}),
		).rejects.toThrow(/returned no credential/)

		const pair = await resolvePrincipalAuthValue(
			async () => ({ credential: "tok", expiresIn: 90, refreshToken: "rt" }),
			"oauth-google",
			{ label: 'principal "g"', outOfBand: { attempts: 1, initialMs: 1, maxMs: 1 } },
		)
		expect(pair.credential).toBe("tok")
	})

	it("creates a principal from the hook and refreshes by calling it again", async () => {
		const model = buildModel(dereference(AUTH_SPEC).doc)
		let n = 0
		const client = new Client("http://127.0.0.1")
		const runtime = await createPrincipal(
			"google",
			{ fromHook: "oauth-google", assumeTtlMs: 1, refreshBufferMs: 10_000 },
			{
				client,
				hooks: {
					resolvePrincipalAuth: async (name) => {
						expect(name).toBe("oauth-google")
						n += 1
						if (n === 1) return { credential: "first", expiresIn: 0 }
						return { credential: "second", expiresIn: 90, refreshToken: "rt" }
					},
				},
				model,
				outOfBand: { attempts: 2, initialMs: 1, maxMs: 1 },
				principalId: "google",
			},
		)
		expect(runtime.headers().authorization).toBe("Bearer first")
		await runtime.refreshIfStale(true)
		expect(runtime.headers().authorization).toBe("Bearer second")
		expect(runtime.scope.refreshToken).toBe("rt")
		expect(runtime.matches({ authorization: "Bearer first" })).toBe(true)
		await runtime.reacquire()
		expect(n).toBe(3)
	})

	it("does not proactive-refresh when expiry is unknown", async () => {
		const model = buildModel(dereference(AUTH_SPEC).doc)
		let n = 0
		const runtime = await createPrincipal(
			"google",
			{ fromHook: "oauth-google" },
			{
				client: new Client("http://127.0.0.1"),
				hooks: {
					resolvePrincipalAuth: async () => {
						n += 1
						return { credential: "static" }
					},
				},
				model,
				outOfBand: { attempts: 1, initialMs: 1, maxMs: 1 },
				principalId: "google",
			},
		)
		expect(runtime.expiresAt).toBeNull()
		await runtime.refreshIfStale()
		expect(n).toBe(1)
	})
})

describe("resolveHeaders", () => {
	it("merges after globalHeaders and before auth", async () => {
		const seen: string[] = []
		const server = await listen((req, res) => {
			seen.push(
				`${req.headers["x-global"] ?? ""}|${req.headers["cf-turnstile-response"] ?? ""}|${req.headers.authorization ?? ""}`,
			)
			send(res, 200, { items: [] })
		})
		closers.push(server.close)
		const client = new Client(server.url, { "x-global": "g" })
		client.setResolveHeaders(async ({ method, url, operationId }) => {
			expect(method).toBe("GET")
			expect(url).toContain("/v1/items")
			expect(operationId).toBe("item.list")
			return { "cf-turnstile-response": "fresh" }
		})
		client.bindAuth({
			headers: () => ({ authorization: "Bearer live" }),
			matches: (headers) => headers.authorization === "Bearer live",
			refreshIfStale: async () => undefined,
		})
		await client.get("/v1/items", {
			headers: { authorization: "Bearer live" },
			operationId: "item.list",
		})
		expect(seen).toEqual(["g|fresh|Bearer live"])
	})

	it("treats a null hook return as no extra headers", async () => {
		const server = await listen((_req, res) => send(res, 200, {}))
		closers.push(server.close)
		const client = new Client(server.url)
		client.setResolveHeaders(async () => null)
		const exchange = await client.get("/v1/items")
		expect(exchange.status).toBe(200)
	})
})

describe("origins and auth-step origin", () => {
	it("sends an auth hop to a named origin", async () => {
		const cdnHits: string[] = []
		const cdn = await listen((req, res) => {
			cdnHits.push(`${req.method} ${req.url}`)
			send(res, 200, { access_token: "from-cdn" })
		})
		closers.push(cdn.close)
		const api = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi") return send(res, 200, AUTH_SPEC)
			send(res, 404)
		})
		closers.push(api.close)

		const cdnSpec = {
			info: { title: "cdn", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/token": {
					post: {
						operationId: "cdn.token",
						requestBody: { content: { "application/json": { schema: { type: "object" } } } },
						responses: { "200": { description: "ok" } },
					},
				},
			},
		} as OpenApiDocument
		const cdnDoc = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi") return send(res, 200, cdnSpec)
			send(res, 404)
		})
		closers.push(cdnDoc.close)

		const model = buildModel(dereference(AUTH_SPEC).doc)
		const originModel = buildModel(dereference(cdnSpec).doc)
		const originClient = new Client(cdn.url)
		const runtime = await createPrincipal(
			"alpha",
			{
				credentialFrom: "$.access_token",
				steps: [{ operationId: "cdn.token", origin: "cdn", body: {} }],
			},
			{
				client: new Client(api.url),
				hooks: {},
				model,
				originClients: new Map([["cdn", { client: originClient, model: originModel }]]),
				principalId: "alpha",
			},
		)
		expect(runtime.headers().authorization).toBe("Bearer from-cdn")
		expect(cdnHits.some((hit) => hit.startsWith("POST"))).toBe(true)

		await expect(
			createPrincipal(
				"alpha",
				{
					credentialFrom: "$.access_token",
					steps: [{ method: "POST", origin: "missing", path: "/x" }],
				},
				{ client: new Client(api.url), hooks: {}, model, principalId: "alpha" },
			),
		).rejects.toThrow(/not in config.origins/)
	})

	it("runs a secondary origin after primary auth and stamps findings", async () => {
		const primarySpec = {
			info: { title: "api", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/notes": {
					get: {
						operationId: "note.list",
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: {
											properties: {
												notes: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
											},
											type: "object",
										},
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "list", identity: "id", name: "note" },
					},
					post: {
						operationId: "note.create",
						requestBody: {
							content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
						},
						responses: {
							"201": {
								content: {
									"application/json": {
										schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "create", identity: "id", name: "note" },
					},
				},
			},
		} as OpenApiDocument

		const cdnSpec = {
			info: { title: "cdn", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/files": {
					get: {
						operationId: "file.list",
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: {
											properties: {
												files: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
											},
											type: "object",
										},
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "list", identity: "id", name: "file" },
					},
					post: {
						operationId: "file.create",
						requestBody: {
							content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
						},
						responses: {
							"201": {
								content: {
									"application/json": {
										schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "create", identity: "id", name: "file" },
					},
				},
			},
		} as OpenApiDocument

		let notes: Array<{ id: string; name: string }> = []
		const api = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/openapi") return send(res, 200, primarySpec)
				if (url.pathname === "/v1/notes" && method === "GET") return send(res, 200, { notes })
				if (url.pathname === "/v1/notes" && method === "POST") {
					const body = (await readJson(req)) as { name?: string }
					const row = { id: `n${notes.length + 1}`, name: body.name ?? "n" }
					notes = [...notes, row]
					return send(res, 201, row)
				}
				return send(res, 404)
			})()
		})
		closers.push(api.close)

		let files: Array<{ id: string; name: string }> = []
		const cdn = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/openapi") return send(res, 200, cdnSpec)
				if (url.pathname === "/v1/files" && method === "GET") return send(res, 200, { files })
				if (url.pathname === "/v1/files" && method === "POST") {
					const body = (await readJson(req)) as { name?: string }
					const row = { id: `f${files.length + 1}`, name: body.name ?? "f" }
					files = [...files, row]
					return send(res, 201, row)
				}
				return send(res, 404)
			})()
		})
		closers.push(cdn.close)

		const result = await run({
			baseUrl: api.url,
			origins: [{ baseUrl: cdn.url, id: "cdn", spec: `${cdn.url}/openapi` }],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${api.url}/openapi`,
		})
		expect(result.entitiesTested.some((name) => name === "note" || name.endsWith(":file") || name === "cdn:file")).toBe(
			true,
		)
		expect(result.principals[0]?.headers.authorization).toBe("Bearer t")
		expect(files.length).toBeGreaterThan(0)
	})
})
