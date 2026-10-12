import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { PRINCIPALS, judgeDefect } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { run } from "../src/runtime/run.ts"

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG"])

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function profileSpec(): OpenApiDocument {
	const profile = {
		properties: {
			first_name: { anyOf: [{ maxLength: 50, type: "string" }, { type: "null" }] },
		},
		type: "object",
	}
	return {
		info: { title: "self", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/me": {
				get: {
					operationId: "profile.read",
					responses: {
						"200": {
							content: { "application/json": { schema: profile } },
							description: "ok",
						},
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "read", identity: "self", name: "profile" },
				},
				patch: {
					operationId: "profile.update",
					requestBody: {
						content: { "application/json": { schema: profile } },
						required: true,
					},
					responses: {
						"200": {
							content: { "application/json": { schema: profile } },
							description: "ok",
						},
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "update", identity: "self", name: "profile" },
				},
			},
		},
	} as OpenApiDocument
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const text = Buffer.concat(chunks).toString("utf8")
	if (text === "") return undefined
	return JSON.parse(text) as unknown
}

async function serve(mode: "hold" | "open" | "forget" | "throttle"): Promise<string> {
	let first = "Ada"
	let patched = false
	const spec = profileSpec()
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") {
				const text = JSON.stringify(spec)
				res.writeHead(200, { "content-type": "application/json" })
				res.end(text)
				return
			}
			if (url.pathname === "/v1/me") {
				const authorized = req.headers.authorization === "Bearer alpha"
				if (!authorized && mode !== "open") {
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unauthorized" }))
					return
				}
				if (method === "GET") {
					/* Throttled: once the update lands, the bucket is empty for every read after it. */
					if (mode === "throttle" && patched) {
						res.writeHead(429, { "content-type": "application/json", "retry-after": "0" })
						res.end(JSON.stringify({ error: "too_many_requests" }))
						return
					}
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ first_name: first }))
					return
				}
				if (method === "PATCH") {
					const body = (await readBody(req)) as { first_name?: unknown }
					if (mode !== "forget" && typeof body.first_name === "string") first = body.first_name
					patched = true
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ first_name: mode === "forget" ? "Ada" : first }))
					return
				}
			}
			res.writeHead(404)
			res.end()
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

function booleanSpec(paths: OpenApiDocument["paths"]): OpenApiDocument {
	return {
		info: { title: "self-boolean", version: "1" },
		openapi: "3.1.0",
		paths,
	} as OpenApiDocument
}

const booleanSchema = {
	properties: { dismissed: { type: "boolean" } },
	required: ["dismissed"],
	type: "object",
}

async function serveBoolean(): Promise<string> {
	let dismissed = false
	const spec = booleanSpec({
		"/v1/me": {
			get: {
				operationId: "profile.read",
				responses: {
					"200": { content: { "application/json": { schema: booleanSchema } }, description: "ok" },
					"401": { description: "unauthorized" },
				},
				"x-entity": { action: "read", identity: "self", name: "profile" },
			},
			patch: {
				operationId: "profile.update",
				requestBody: { content: { "application/json": { schema: booleanSchema } }, required: true },
				responses: {
					"200": { content: { "application/json": { schema: booleanSchema } }, description: "ok" },
					"401": { description: "unauthorized" },
				},
				"x-entity": { action: "update", identity: "self", name: "profile" },
			},
		},
	})
	return serveSpec(
		spec,
		() => ({ dismissed }),
		(body) => {
			if (typeof body.dismissed === "boolean") dismissed = body.dismissed
		},
	)
}

async function serveEnumAndBoolean(): Promise<string> {
	let dismissed = false
	const schema = {
		properties: {
			channel: { enum: ["app", "email"], type: "string" },
			dismissed: { type: "boolean" },
		},
		required: ["channel", "dismissed"],
		type: "object",
	}
	const spec = booleanSpec({
		"/v1/me": {
			get: {
				operationId: "profile.read",
				responses: {
					"200": { content: { "application/json": { schema } }, description: "ok" },
					"401": { description: "unauthorized" },
				},
				"x-entity": { action: "read", identity: "self", name: "profile" },
			},
			patch: {
				operationId: "profile.update",
				requestBody: { content: { "application/json": { schema } }, required: true },
				responses: {
					"200": { content: { "application/json": { schema } }, description: "ok" },
					"401": { description: "unauthorized" },
				},
				"x-entity": { action: "update", identity: "self", name: "profile" },
			},
		},
	})
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(spec))
				return
			}
			if (url.pathname === "/v1/me") {
				if (req.headers.authorization !== "Bearer alpha") {
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unauthorized" }))
					return
				}
				if (method === "GET") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ channel: "app", dismissed }))
					return
				}
				if (method === "PATCH") {
					const body = (await readBody(req)) as { dismissed?: unknown }
					if (typeof body.dismissed === "boolean") dismissed = body.dismissed
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ channel: "app", dismissed }))
					return
				}
			}
			res.writeHead(404)
			res.end()
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

async function serveTwoReads(): Promise<string> {
	let dismissed = false
	const read = {
		responses: {
			"200": { content: { "application/json": { schema: booleanSchema } }, description: "ok" },
			"401": { description: "unauthorized" },
		},
		"x-entity": { action: "read", identity: "self", name: "profile" },
	}
	const spec = booleanSpec({
		"/v1/me": {
			get: { ...read, operationId: "profile.read" },
			patch: {
				operationId: "profile.update",
				requestBody: { content: { "application/json": { schema: booleanSchema } }, required: true },
				responses: read.responses,
				"x-entity": { action: "update", identity: "self", name: "profile" },
			},
		},
		"/v1/me/flags": {
			get: { ...read, operationId: "profile.flags" },
		},
	})
	return serveSpec(
		spec,
		() => ({ dismissed }),
		(body) => {
			if (typeof body.dismissed === "boolean") dismissed = body.dismissed
		},
	)
}

async function serveSpec(
	spec: OpenApiDocument,
	read: () => { dismissed: boolean },
	write: (body: { dismissed?: unknown }) => void,
): Promise<string> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json" && method === "GET") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(spec))
				return
			}
			if (url.pathname === "/v1/me" || url.pathname === "/v1/me/flags") {
				if (req.headers.authorization !== "Bearer alpha") {
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unauthorized" }))
					return
				}
				if (method === "GET") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(read()))
					return
				}
				if (method === "PATCH" && url.pathname === "/v1/me") {
					write((await readBody(req)) as { dismissed?: unknown })
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(read()))
					return
				}
			}
			res.writeHead(404)
			res.end()
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

async function runProfile(baseUrl: string) {
	return run({
		baseUrl,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${baseUrl}/openapi.json`,
	})
}

describe("identity self", () => {
	it("reads the caller, sees an update stick, and refuses a missing token", async () => {
		const url = await serve("hold")
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.entitiesTested).toEqual(["profile"])
		const read = result.scope.operations.find((op) => op.operationId === "profile.read")
		const update = result.scope.operations.find((op) => op.operationId === "profile.update")
		expect(read?.status).toBe("passed")
		expect(update?.status).toBe("passed")
		expect(read?.checks.passed).toContain("auth.self-is-the-caller")
		const anonymous = result.client.transcript.find((exchange) => exchange.status === 401)
		expect(anonymous?.requestHeaders.authorization).toBeUndefined()
		const patched = result.client.transcript.find((exchange) => exchange.method === "PATCH")
		expect(patched?.requestBody).toEqual({ first_name: "Oat" })
	})

	it("reports a caller route that answers with no token", async () => {
		const url = await serve("open")
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.check)).toContain("auth.self-is-the-caller")
		expect(result.scope.operations.find((op) => op.operationId === "profile.read")?.status).toBe("failed")
	})

	it("reports an update the next read does not show", async () => {
		const url = await serve("forget")
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.summary)).toContain("an update to the caller did not stick")
		expect(result.scope.operations.find((op) => op.operationId === "profile.update")?.status).toBe("failed")
	})

	it("does not call a rate-limited read a lost update", async () => {
		const url = await serve("throttle")
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects.map((finding) => finding.summary)).not.toContain("an update to the caller did not stick")
		expect(result.scope.operations.find((op) => op.operationId === "profile.update")?.status).not.toBe("failed")
	})

	it("flips a boolean-only caller field, reads it back, and restores it", async () => {
		const url = await serveBoolean()
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		const patches = result.client.transcript.filter((exchange) => exchange.method === "PATCH")
		expect(patches.map((exchange) => exchange.requestBody)).toEqual([{ dismissed: true }, { dismissed: false }])
		const reads = result.client.transcript.filter((exchange) => exchange.method === "GET" && exchange.status === 200)
		expect(
			reads.some(
				(exchange) =>
					exchange.responseBody !== null && (exchange.responseBody as { dismissed?: boolean }).dismissed === true,
			),
		).toBe(true)
	})

	it("flips a boolean when the only other field is an enum", async () => {
		const url = await serveEnumAndBoolean()
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		const patches = result.client.transcript.filter((exchange) => exchange.method === "PATCH")
		expect(patches[0]?.requestBody).toEqual({ dismissed: true })
	})

	it("creates the caller through the spec create before the read", async () => {
		let stored: { display_name: string } | undefined
		const schema = {
			properties: {
				display_name: { maxLength: 50, minLength: 1, type: "string" },
				link_label: { maxLength: 20, type: "string" },
			},
			required: ["display_name"],
			type: "object",
		}
		const spec = booleanSpec({
			"/v1/me": {
				get: {
					operationId: "profile.read",
					responses: {
						"200": { content: { "application/json": { schema } }, description: "ok" },
						"401": { description: "unauthorized" },
						"404": { description: "missing" },
					},
					"x-entity": { action: "read", identity: "self", name: "profile" },
				},
				patch: {
					operationId: "profile.update",
					requestBody: { content: { "application/json": { schema } }, required: true },
					responses: {
						"200": { content: { "application/json": { schema } }, description: "ok" },
						"401": { description: "unauthorized" },
						"404": { description: "missing" },
					},
					"x-entity": { action: "update", identity: "self", name: "profile" },
				},
				post: {
					operationId: "profile.create",
					requestBody: { content: { "application/json": { schema } }, required: true },
					responses: {
						"201": { content: { "application/json": { schema } }, description: "created" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "create", identity: "self", name: "profile" },
				},
			},
		})
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/openapi.json" && method === "GET") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(spec))
					return
				}
				if (url.pathname === "/v1/me") {
					if (req.headers.authorization !== "Bearer alpha") {
						res.writeHead(401, { "content-type": "application/json" })
						res.end(JSON.stringify({ error: "unauthorized" }))
						return
					}
					if (method === "POST") {
						const body = (await readBody(req)) as { display_name?: unknown; link_label?: unknown }
						if ("link_label" in body) {
							res.writeHead(400, { "content-type": "application/json" })
							res.end(JSON.stringify({ error: "label without url" }))
							return
						}
						if (typeof body.display_name !== "string" || body.display_name === "") {
							res.writeHead(400, { "content-type": "application/json" })
							res.end(JSON.stringify({ error: "invalid" }))
							return
						}
						stored = { display_name: body.display_name }
						res.writeHead(201, { "content-type": "application/json" })
						res.end(JSON.stringify(stored))
						return
					}
					if (stored === undefined) {
						res.writeHead(404, { "content-type": "application/json" })
						res.end(JSON.stringify({ error: "missing" }))
						return
					}
					if (method === "GET") {
						res.writeHead(200, { "content-type": "application/json" })
						res.end(JSON.stringify(stored))
						return
					}
					if (method === "PATCH") {
						const body = (await readBody(req)) as { display_name?: unknown }
						if (typeof body.display_name === "string") stored = { display_name: body.display_name }
						res.writeHead(200, { "content-type": "application/json" })
						res.end(JSON.stringify(stored))
						return
					}
				}
				res.writeHead(404)
				res.end()
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		for (const id of ["profile.create", "profile.read", "profile.update"]) {
			expect(result.scope.operations.find((op) => op.operationId === id)?.status).toBe("passed")
		}
		const post = result.client.transcript.find((exchange) => exchange.method === "POST" && exchange.status === 201)
		const sent = (post?.requestBody as { display_name?: unknown } | undefined)?.display_name
		const firstRead = result.client.transcript.find((exchange) => exchange.method === "GET" && exchange.status === 200)
		expect(sent).toEqual(expect.any(String))
		expect((firstRead?.responseBody as { display_name?: unknown } | undefined)?.display_name).toBe(sent)
		const postAt = result.client.transcript.findIndex((exchange) => exchange.method === "POST")
		const readAt = result.client.transcript.findIndex(
			(exchange) => exchange.method === "GET" && exchange.status === 200,
		)
		expect(postAt).toBeGreaterThanOrEqual(0)
		expect(readAt).toBeGreaterThan(postAt)
	})

	it("flips a boolean the read nests under other keys", async () => {
		const channels = { app: { dismissed: true }, email: { dismissed: true } }
		const readSchema = {
			additionalProperties: booleanSchema,
			type: "object",
		}
		const updateSchema = {
			properties: {
				channel: { enum: ["app", "email"], type: "string" },
				dismissed: { type: "boolean" },
			},
			type: "object",
		}
		const spec = booleanSpec({
			"/v1/me": {
				get: {
					operationId: "profile.read",
					responses: {
						"200": { content: { "application/json": { schema: readSchema } }, description: "ok" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "read", identity: "self", name: "profile" },
				},
				patch: {
					operationId: "profile.update",
					requestBody: { content: { "application/json": { schema: updateSchema } }, required: true },
					responses: {
						"200": { content: { "application/json": { schema: readSchema } }, description: "ok" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "update", identity: "self", name: "profile" },
				},
			},
		})
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/openapi.json" && method === "GET") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(spec))
					return
				}
				if (url.pathname === "/v1/me") {
					if (req.headers.authorization !== "Bearer alpha") {
						res.writeHead(401, { "content-type": "application/json" })
						res.end(JSON.stringify({ error: "unauthorized" }))
						return
					}
					if (method === "GET") {
						res.writeHead(200, { "content-type": "application/json" })
						res.end(JSON.stringify(channels))
						return
					}
					if (method === "PATCH") {
						const body = (await readBody(req)) as { dismissed?: unknown }
						if (typeof body.dismissed === "boolean") channels.email.dismissed = body.dismissed
						res.writeHead(200, { "content-type": "application/json" })
						res.end(JSON.stringify(channels))
						return
					}
				}
				res.writeHead(404)
				res.end()
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		const patches = result.client.transcript.filter((exchange) => exchange.method === "PATCH")
		expect(patches.map((exchange) => exchange.requestBody)).toEqual([{ dismissed: false }, { dismissed: true }])
		expect(result.scope.operations.find((op) => op.operationId === "profile.update")?.status).toBe("passed")
	})

	it("asks a caller query with the handle the create just sent", async () => {
		let stored: { display_name: string; handle: string } | undefined
		let seen = ""
		const bodySchema = {
			properties: {
				display_name: { maxLength: 80, minLength: 1, type: "string" },
				handle: { maxLength: 32, minLength: 3, type: "string" },
			},
			required: ["display_name", "handle"],
			type: "object",
		}
		const answer = {
			properties: { available: { type: "boolean" } },
			required: ["available"],
			type: "object",
		}
		const spec = booleanSpec({
			"/v1/handle-available": {
				get: {
					operationId: "profile.available",
					parameters: [{ in: "query", name: "handle", required: true, schema: { minLength: 1, type: "string" } }],
					responses: {
						"200": { content: { "application/json": { schema: answer } }, description: "ok" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "action", identity: "self", name: "profile" },
				},
			},
			"/v1/me": {
				get: {
					operationId: "profile.read",
					responses: {
						"200": { content: { "application/json": { schema: bodySchema } }, description: "ok" },
						"401": { description: "unauthorized" },
						"404": { description: "missing" },
					},
					"x-entity": { action: "read", identity: "self", name: "profile" },
				},
				patch: {
					operationId: "profile.update",
					requestBody: { content: { "application/json": { schema: bodySchema } }, required: true },
					responses: {
						"200": { content: { "application/json": { schema: bodySchema } }, description: "ok" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "update", identity: "self", name: "profile" },
				},
				post: {
					operationId: "profile.create",
					requestBody: { content: { "application/json": { schema: bodySchema } }, required: true },
					responses: {
						"201": { content: { "application/json": { schema: bodySchema } }, description: "created" },
						"401": { description: "unauthorized" },
					},
					"x-entity": { action: "create", identity: "self", name: "profile" },
				},
			},
		})
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/openapi.json" && method === "GET") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(spec))
					return
				}
				if (req.headers.authorization !== "Bearer alpha" && url.pathname !== "/openapi.json") {
					res.writeHead(401, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unauthorized" }))
					return
				}
				if (url.pathname === "/v1/handle-available" && method === "GET") {
					seen = url.searchParams.get("handle") ?? ""
					const available = stored !== undefined && seen === stored.handle
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ available }))
					return
				}
				if (url.pathname === "/v1/me" && method === "POST") {
					const body = (await readBody(req)) as { display_name?: unknown; handle?: unknown }
					if (typeof body.display_name !== "string" || typeof body.handle !== "string") {
						res.writeHead(400)
						res.end()
						return
					}
					stored = { display_name: body.display_name, handle: body.handle }
					res.writeHead(201, { "content-type": "application/json" })
					res.end(JSON.stringify(stored))
					return
				}
				if (url.pathname === "/v1/me" && stored !== undefined && method === "GET") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(stored))
					return
				}
				if (url.pathname === "/v1/me" && method === "PATCH" && stored !== undefined) {
					const body = (await readBody(req)) as { display_name?: unknown }
					if (typeof body.display_name === "string") stored = { ...stored, display_name: body.display_name }
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(stored))
					return
				}
				res.writeHead(404)
				res.end()
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		expect(result.scope.operations.find((op) => op.operationId === "profile.available")?.status).toBe("passed")
		expect(seen).not.toBe("")
		expect(seen).toBe(stored?.handle)
	})

	it("grades both reads on one caller entity", async () => {
		const url = await serveTwoReads()
		const result = await runProfile(url)
		const defects = result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))
		expect(defects).toEqual([])
		for (const id of ["profile.read", "profile.flags"]) {
			const op = result.scope.operations.find((item) => item.operationId === id)
			expect(op?.status).toBe("passed")
			expect(op?.checks.passed).toContain("auth.self-is-the-caller")
		}
		const paths = result.client.transcript
			.filter((exchange) => exchange.method === "GET" && exchange.status === 200)
			.map((exchange) => new URL(exchange.url).pathname)
		expect(paths).toContain("/v1/me")
		expect(paths).toContain("/v1/me/flags")
	})

	it("the reference backend is caught only when the caller update does not stick", async () => {
		const dropped = await judgeDefect("CALLER_UPDATE_DROPPED", "memory", "postgrest")
		expect(dropped.error).toBeUndefined()
		expect(dropped.detected).toBe(true)
		expect(dropped.spurious).toEqual([])
	})

	it("an untagged reference does not blame the caller routes", async () => {
		const server = await createMemoryServer({ untagged: true })
		open.push(server)
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const blamed = result.findings.filter(
			(finding) =>
				DEFECT_VERDICTS.has(finding.verdict) &&
				(finding.entity === "profile" || finding.entity === "me" || finding.check === "auth.self-is-the-caller"),
		)
		expect(blamed).toEqual([])
	})
})
