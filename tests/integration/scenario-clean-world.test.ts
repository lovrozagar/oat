import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Scenario } from "../../src/config/define/types.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A scenario sets its own scene. Records the matrix made for its checks are gone before it runs:
 * an invite a check left pending would otherwise refuse the scenario's own invite as a duplicate.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const note = {
	properties: { id: { type: "string" }, text: { type: "string" } },
	required: ["id", "text"],
	type: "object",
}
const spec: OpenApiDocument = {
	info: { title: "clean-world", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/notes": {
			get: {
				operationId: "notes.list",
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: { count: { type: "integer" }, items: { items: note, type: "array" } },
									required: ["items", "count"],
									type: "object",
								},
							},
						},
						description: "ok",
					},
				},
			},
			post: {
				operationId: "notes.create",
				requestBody: {
					content: {
						"application/json": {
							schema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" },
						},
					},
				},
				responses: { "201": { content: { "application/json": { schema: note } }, description: "ok" } },
			},
		},
		"/v1/notes/{id}": {
			delete: {
				operationId: "notes.delete",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "gone" } },
			},
			get: {
				operationId: "notes.get",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { "200": { content: { "application/json": { schema: note } }, description: "ok" } },
			},
		},
	},
} as OpenApiDocument

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let text = ""
		req.on("data", (chunk: Buffer) => {
			text += chunk.toString()
		})
		req.on("end", () => resolve(text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)))
	})
}

describe("scenarios start from a clean world", () => {
	it("removes the matrix's fixtures before any scenario runs", async () => {
		const notes = new Map<string, { id: string; text: string }>()
		let next = 0
		const server = createServer((req, res) => {
			const send = (status: number, body?: unknown) => {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(body === undefined ? "" : JSON.stringify(body))
			}
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				if (url.pathname === "/openapi.json") return send(200, spec)
				if (url.pathname === "/v1/notes" && req.method === "GET") {
					return send(200, { count: notes.size, items: [...notes.values()] })
				}
				if (url.pathname === "/v1/notes" && req.method === "POST") {
					const body = await readBody(req)
					const id = `n_${++next}`
					notes.set(id, { id, text: String(body["text"] ?? "") })
					return send(201, notes.get(id))
				}
				const id = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname)?.[1]
				if (id !== undefined && req.method === "DELETE") {
					notes.delete(id)
					return send(204)
				}
				if (id !== undefined && notes.has(id)) return send(200, notes.get(id))
				send(404)
			})()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		closers.push(() => new Promise((resolve) => server.close(() => resolve())))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		const scenario: Scenario = {
			covers: ["notes.list"],
			id: "empty-start",
			steps: [{ assert: { equals: "0", from: "$.count" }, operationId: "notes.list" }],
		}
		const result = await run({
			baseUrl: url,
			principals: { alpha: {} },
			scenarios: [scenario],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(next).toBeGreaterThan(0)
		expect(result.findings.filter((finding) => finding.check === "scenario.empty-start")).toEqual([])
		expect(notes.size).toBe(0)
	})
})
