import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../src/spec/types.ts"
import { run } from "../src/runtime/run.ts"

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

const PNG = Uint8Array.of(
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a,
	0x00,
	0x00,
	0x00,
	0x0d,
	0x49,
	0x48,
	0x44,
	0x52,
	0x00,
	0x00,
	0x00,
	0x01,
	0x00,
	0x00,
	0x00,
	0x01,
	0x08,
	0x06,
	0x00,
	0x00,
	0x00,
	0x1f,
	0x15,
	0xc4,
	0x89,
	0x00,
	0x00,
	0x00,
	0x0a,
	0x49,
	0x44,
	0x41,
	0x54,
	0x78,
	0x9c,
	0x63,
	0x00,
	0x01,
	0x00,
	0x00,
	0x05,
	0x00,
	0x01,
	0x0d,
	0x0a,
	0x2d,
	0xb4,
	0x00,
	0x00,
	0x00,
	0x00,
	0x49,
	0x45,
	0x4e,
	0x44,
	0xae,
	0x42,
	0x60,
	0x82,
)

function token(sub: string): string {
	const body = Buffer.from(JSON.stringify({ orgs: [{ oid: "org_1" }], sub })).toString("base64url")
	return `Bearer h.${body}.s`
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = createServer(handler)
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo
			open.push({ close: () => new Promise((done) => server.close(() => done())) })
			resolve(`http://127.0.0.1:${address.port}`)
		})
	})
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = []
	return new Promise((resolve) => {
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => resolve(Buffer.concat(chunks)))
	})
}

describe("uploads", () => {
	it("shows the avatar on the profile read and clears it on remove", async () => {
		const url = "https://cdn.example.test/cdn/p/u/usr_1/avatar-abc.png"
		let shown = false
		const api = await listen(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname
			if (path === "/openapi.json") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(imageDocument()))
				return
			}
			if (req.method === "POST" && path === "/v1/auth/me/avatar") {
				shown = true
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ avatar_url: url }))
				return
			}
			if (req.method === "DELETE") {
				shown = false
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ avatar_url: null }))
				return
			}
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ avatar_url: shown ? url : null }))
		})
		const cdn = await listen(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname
			if (path === "/openapi.json") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(objectDocument()))
				return
			}
			const body = await readBody(req)
			expect(body.equals(Buffer.from(PNG))).toBe(true)
			res.writeHead(201, { "content-type": "application/json" })
			res.end(JSON.stringify({ key: "u/u/usr_1/oat.png" }))
		})
		const result = await run({
			baseUrl: api,
			ops: ["auth.commitAvatar", "auth.removeAvatar"],
			origins: [{ baseUrl: cdn, id: "cdn", spec: `${cdn}/openapi.json` }],
			principals: [{ headers: { authorization: token("usr_1") }, id: "alpha" }],
			seed: 1,
			spec: `${api}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "auth.commitAvatar")?.status).toBe("passed")
		expect(result.scope.operations.find((op) => op.operationId === "auth.removeAvatar")?.status).toBe("passed")
	})

	it("reads the uploaded bytes and describes them", async () => {
		let stored = false
		const base = await listen(async (req, res) => {
			const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname
			if (path === "/openapi.json") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(objectDocument()))
				return
			}
			if (req.method === "PUT") {
				stored = true
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify({ key: "s/o/org_1/oat-object.png" }))
				return
			}
			if (req.method === "HEAD") {
				res.writeHead(stored ? 200 : 404, {
					"content-length": String(PNG.byteLength),
					"content-type": "image/png",
				})
				res.end()
				return
			}
			res.writeHead(200, { "content-type": "image/png" })
			res.end(PNG)
		})
		const result = await run({
			baseUrl: base,
			ops: ["cdn.upload", "cdn.read", "cdn.head"],
			principals: [{ headers: { authorization: token("usr_1") }, id: "alpha", roots: { organization_id: "org_1" } }],
			seed: 1,
			spec: `${base}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "cdn.upload")?.status).toBe("passed")
		expect(result.scope.operations.find((op) => op.operationId === "cdn.read")?.status).toBe("passed")
		expect(result.scope.operations.find((op) => op.operationId === "cdn.head")?.status).toBe("passed")
	})
})

function imageDocument(): OpenApiDocument {
	return {
		info: { title: "image", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/auth/me": { get: { operationId: "auth.getProfile", responses: { "200": { description: "ok" } } } },
			"/v1/auth/me/avatar": {
				delete: { operationId: "auth.removeAvatar", responses: { "200": { description: "ok" } } },
				post: {
					operationId: "auth.commitAvatar",
					responses: { "200": { description: "ok" } },
					"x-image": true,
					"x-invalidate": ["GET /v1/auth/me"],
				},
			},
		},
	} as OpenApiDocument
}

function objectDocument(): OpenApiDocument {
	return {
		info: { title: "cdn", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/cdn/s/{wildcard}": {
				get: { operationId: "cdn.read", responses: { "200": { description: "ok" } } },
				head: { operationId: "cdn.head", responses: { "200": { description: "ok" } } },
			},
			"/cdn/u/{wildcard}": {
				put: { operationId: "cdn.upload", responses: { "201": { description: "ok" } }, "x-object": true },
			},
		},
	} as OpenApiDocument
}
