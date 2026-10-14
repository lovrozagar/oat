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

const versionBody = {
	"application/json": {
		schema: { properties: { version: { type: "string" } }, required: ["version"], type: "object" },
	},
}
const accepted = {
	"application/json": {
		schema: { properties: { received: { type: "boolean" } }, required: ["received"], type: "object" },
	},
}
const feedback = {
	content: {
		"application/json": {
			schema: { properties: { message: { type: "string" } }, required: ["message"], type: "object" },
		},
	},
}
const noteSchema = {
	properties: { id: { type: "string" }, text: { type: "string" } },
	required: ["id", "text"],
	type: "object",
}

const ok = (content: unknown, code = "200") => ({ [code]: { content, description: "ok" } })

function spec(): OpenApiDocument {
	return {
		components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
		info: { title: "contract", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/accounts/{account_id}/badge": {
				get: {
					operationId: "badge.get",
					parameters: [{ in: "path", name: "account_id", required: true, schema: { type: "string" } }],
					responses: ok(versionBody),
				},
			},
			"/v1/broken": { get: { operationId: "broken.get", responses: ok(versionBody) } },
			"/v1/crash": { get: { operationId: "crash.get", responses: ok(versionBody) } },
			"/v1/feedback": { post: { operationId: "feedback.send", requestBody: feedback, responses: ok(accepted, "202") } },
			"/v1/notes": {
				get: {
					operationId: "notes.list",
					responses: ok({
						"application/json": {
							schema: {
								properties: { items: { items: noteSchema, type: "array" } },
								required: ["items"],
								type: "object",
							},
						},
					}),
				},
				post: {
					operationId: "notes.write",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" },
							},
						},
					},
					responses: ok({ "application/json": { schema: noteSchema } }, "201"),
				},
			},
			"/v1/notes/archive-all": {
				post: {
					operationId: "notes.archiveAll",
					responses: ok(accepted),
					"x-entity": { action: "action", identity: "id", name: "note" },
					"x-rate-limit": { category: "archive", rps: 5 },
				},
			},
			"/v1/notes/{note_id}": {
				delete: {
					operationId: "notes.remove",
					parameters: [{ in: "path", name: "note_id", required: true, schema: { type: "string" } }],
					responses: { "204": { description: "gone" }, "404": { description: "missing" } },
				},
				get: {
					operationId: "notes.get",
					parameters: [{ in: "path", name: "note_id", required: true, schema: { type: "string" } }],
					responses: { ...ok({ "application/json": { schema: noteSchema } }), "404": { description: "missing" } },
				},
			},
			"/v1/notes/stats": {
				get: {
					operationId: "notes.stats",
					parameters: [{ in: "query", name: "aggs", required: true, schema: { type: "string" } }],
					responses: ok(accepted),
					"x-bind": { query: { aggs: "text.count" } },
					"x-effects": [],
				},
			},
			"/v1/notes/tag": {
				post: {
					operationId: "notes.tag",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { tag: { type: "string" } }, required: ["tag"], type: "object" },
							},
						},
					},
					responses: ok(accepted),
					"x-bind": { body: { tag: "pinned" } },
					"x-effects": [],
				},
			},
			"/v1/picky": { post: { operationId: "picky.send", requestBody: feedback, responses: ok(accepted, "202") } },
			"/v1/version": { get: { operationId: "version.get", responses: ok(versionBody) } },
		},
		security: [{ bearer: [] }],
	} as unknown as OpenApiDocument
}

async function serve(options: { keepDeleted?: boolean } = {}): Promise<string> {
	const notes: Array<{ id: string; text: string }> = []
	let created = 0
	const document = spec()
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const method = (req.method ?? "GET").toUpperCase()
		let raw = ""
		for await (const chunk of req) raw += chunk
		const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)
		const send = (status: number, value: unknown) => {
			res.writeHead(status, { "content-type": "application/json" })
			res.end(JSON.stringify(value))
		}
		if (url.pathname === "/openapi.json") return send(200, document)
		if (req.headers.authorization !== "Bearer alpha") return send(401, { error: "unauthorized" })
		if (url.pathname === "/v1/version") return send(200, { version: "1.2.3" })
		if (url.pathname === "/v1/broken") return send(200, { version: 5 })
		if (url.pathname === "/v1/crash") return send(500, { error: "boom" })
		if (url.pathname === "/v1/feedback" && method === "POST") {
			if (typeof body["message"] !== "string") return send(400, { error: "message_required" })
			return send(202, { received: true })
		}
		if (url.pathname === "/v1/notes/stats") {
			if (url.searchParams.get("aggs") !== "text.count") return send(400, { error: "invalid_aggregation" })
			return send(200, { received: true })
		}
		if (url.pathname === "/v1/notes/tag") {
			if (body["tag"] !== "pinned") return send(400, { error: "unknown_tag" })
			return send(200, { received: true })
		}
		if (url.pathname === "/v1/picky") return send(422, { error: "needs_a_real_order" })
		if (url.pathname === "/v1/notes" && method === "POST") {
			if (typeof body["text"] !== "string") return send(400, { error: "text_required" })
			created += 1
			const note = { id: `n${created}`, text: body["text"] }
			notes.push(note)
			return send(201, note)
		}
		if (url.pathname === "/v1/notes" && method === "GET") return send(200, { items: notes })
		if (url.pathname === "/v1/notes/archive-all" && method === "POST") return send(200, { received: true })
		const item = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname)
		if (item !== null) {
			const index = notes.findIndex((note) => note.id === item[1])
			if (index < 0) return send(404, { error: "not_found" })
			if (method === "GET") return send(200, notes[index])
			if (method === "DELETE") {
				if (options.keepDeleted !== true) notes.splice(index, 1)
				res.writeHead(204)
				res.end()
				return
			}
		}
		send(404, { error: "not_found" })
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function fullRun(options: { keepDeleted?: boolean } = {}) {
	const url = await serve(options)
	return run({
		baseUrl: url,
		principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
}

describe("the contract tier", () => {
	it("calls an operation nothing else graded and passes it on a documented, schema-valid success", async () => {
		const result = await fullRun()
		for (const id of ["version.get", "feedback.send"]) {
			const row = result.scope.operations.find((op) => op.operationId === id)
			expect(row?.status).toBe("passed")
			expect(row?.tier).toBe("contract")
			const call = result.client.transcript.find((exchange) => exchange.seq === row?.evidence?.call)
			expect(call?.operationId).toBe(id)
			expect(call?.status).toBeGreaterThanOrEqual(200)
			expect(call?.status).toBeLessThan(300)
		}
	})

	it("calls a rate-limited action no check sends a request to", async () => {
		const result = await fullRun()
		const row = result.scope.operations.find((op) => op.operationId === "notes.archiveAll")
		expect(row?.status).toBe("passed")
		expect(result.client.transcript.some((exchange) => exchange.operationId === "notes.archiveAll")).toBe(true)
	})

	it("sends the values the operation binds in x-bind", async () => {
		const result = await fullRun()
		for (const id of ["notes.stats", "notes.tag"]) {
			const row = result.scope.operations.find((op) => op.operationId === id)
			expect(row?.status, `${id}: ${row?.reason ?? ""}`).toBe("passed")
			expect(row?.tier).toBe("contract")
		}
	})

	it("fails a success whose body breaks the documented schema", async () => {
		const result = await fullRun()
		expect(result.scope.operations.find((op) => op.operationId === "broken.get")?.status).toBe("failed")
	})

	it("fails a server error", async () => {
		const result = await fullRun()
		expect(result.scope.operations.find((op) => op.operationId === "crash.get")?.status).toBe("failed")
	})

	it("leaves an operation untested, with the reason, when its request was refused", async () => {
		const result = await fullRun()
		const picky = result.scope.operations.find((op) => op.operationId === "picky.send")
		expect(picky?.status).toBe("untested")
		expect(picky?.reason).toContain("returned 422")
	})

	it("names the path parameter it could not fill", async () => {
		const result = await fullRun()
		const badge = result.scope.operations.find((op) => op.operationId === "badge.get")
		expect(badge?.status).toBe("untested")
		expect(badge?.reason).toContain("unresolved param account_id")
	})
})

describe("matrix evidence", () => {
	it("proves a delete by the later read that no longer finds it", async () => {
		const result = await fullRun()
		const removed = result.scope.operations.find((op) => op.operationId === "notes.remove")
		expect(removed?.status).toBe("passed")
		expect(removed?.tier).toBe("verified")
		const call = result.client.transcript.find((exchange) => exchange.seq === removed?.evidence?.call)
		const seen = result.client.transcript.find((exchange) => exchange.seq === removed?.evidence?.observation?.seq)
		expect(call?.method).toBe("DELETE")
		expect(seen?.method).toBe("GET")
		expect(seen?.seq).toBeGreaterThan(call?.seq ?? Number.POSITIVE_INFINITY)
		expect(seen?.status).toBe(404)
		expect(new URL(seen?.url ?? "http://x/").pathname).toBe(new URL(call?.url ?? "http://y/").pathname)
		expect(removed?.evidence?.observation).toMatchObject({ status: 404 })
	})

	it("fails a delete whose record is still readable afterwards", async () => {
		const result = await fullRun({ keepDeleted: true })
		expect(result.scope.operations.find((op) => op.operationId === "notes.remove")?.status).toBe("failed")
		expect(result.findings.map((finding) => finding.summary)).toContain("a deleted record is still readable")
	})

	it("shows the later read that holds a matrix-graded write's value", async () => {
		const result = await fullRun()
		const write = result.scope.operations.find((op) => op.operationId === "notes.write")
		expect(write?.status).toBe("passed")
		expect(write?.tier).toBe("verified")
		const call = result.client.transcript.find((exchange) => exchange.seq === write?.evidence?.call)
		const seen = result.client.transcript.find((exchange) => exchange.seq === write?.evidence?.observation?.seq)
		expect(call?.operationId).toBe("notes.write")
		expect(seen?.seq).toBeGreaterThan(call?.seq ?? Number.POSITIVE_INFINITY)
		expect(JSON.stringify(seen?.responseBody)).toContain(write?.evidence?.observation?.value ?? "missing")
	})
})
