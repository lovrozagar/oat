import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A backend whose create takes a client-chosen id and answers only an acknowledgement
 * (`{ success: true }`), the way a file-backed config store or a git-committing API does.
 * The record is what the client sent; oat must track it by that id, read it back, and remove it.
 */

const DEFECT_VERDICTS = new Set(["BACKEND_BUG", "SECURITY", "SPEC_BUG", "AMBIGUITY"])

type Row = { id: string; name: string }

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function spec(): OpenApiDocument {
	const note = {
		additionalProperties: false,
		properties: { id: { minLength: 1, type: "string" }, name: { minLength: 1, type: "string" } },
		required: ["id", "name"],
		type: "object",
	}
	const ack = {
		content: {
			"application/json": {
				schema: { properties: { success: { type: "boolean" } }, type: "object" },
			},
		},
		description: "ok",
	}
	const idParam = [{ in: "path", name: "noteId", required: true, schema: { type: "string" } }]
	return {
		info: { title: "acknowledged-create", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					responses: {
						"200": {
							content: { "application/json": { schema: { items: note, type: "array" } } },
							description: "ok",
						},
					},
				},
				post: {
					operationId: "note.create",
					requestBody: { content: { "application/json": { schema: note } }, required: true },
					responses: { "200": ack, "400": { description: "invalid" }, "409": { description: "taken" } },
					/* a client-chosen id is a unique column: a second create with it is 409 */
					"x-unique": [["id"]],
				},
			},
			"/notes/{noteId}": {
				put: {
					operationId: "note.update",
					parameters: idParam,
					requestBody: { content: { "application/json": { schema: note } }, required: true },
					responses: { "200": ack, "400": { description: "invalid" }, "404": { description: "missing" } },
				},
				delete: {
					operationId: "note.delete",
					parameters: idParam,
					responses: { "200": ack, "404": { description: "missing" } },
				},
				get: {
					operationId: "note.get",
					parameters: idParam,
					responses: {
						"200": { content: { "application/json": { schema: note } }, description: "ok" },
						"404": { description: "missing" },
					},
				},
			},
		},
	} as OpenApiDocument
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const raw = Buffer.concat(chunks).toString("utf8")
	return raw === "" ? undefined : JSON.parse(raw)
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

async function serve(rows: Map<string, Row>): Promise<string> {
	const document = spec()
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json") return send(res, 200, document)
			if (url.pathname === "/notes" && method === "GET") return send(res, 200, [...rows.values()])
			if (url.pathname === "/notes" && method === "POST") {
				const body = (await readJson(req)) as Partial<Row> | undefined
				if (typeof body?.id !== "string" || body.id === "" || typeof body.name !== "string" || body.name === "") {
					return send(res, 400, { success: false })
				}
				if (rows.has(body.id)) return send(res, 409, { success: false })
				rows.set(body.id, { id: body.id, name: body.name })
				return send(res, 200, { success: true })
			}
			const item = url.pathname.match(/^\/notes\/([^/]+)$/)
			const id = decodeURIComponent(item?.[1] ?? "")
			if (item !== null && method === "GET") {
				const row = rows.get(id)
				return row === undefined ? send(res, 404, {}) : send(res, 200, row)
			}
			if (item !== null && method === "PUT") {
				const body = (await readJson(req)) as Partial<Row> | undefined
				if (!rows.has(id)) return send(res, 404, {})
				if (typeof body?.name !== "string" || body.name === "") return send(res, 400, { success: false })
				if (body.id !== undefined && body.id !== id) return send(res, 400, { success: false })
				rows.set(id, { id, name: body.name })
				return send(res, 200, { success: true })
			}
			if (item !== null && method === "DELETE") {
				return rows.delete(id) ? send(res, 200, { success: true }) : send(res, 404, {})
			}
			return send(res, 404, {})
		})().catch(() => {
			if (!res.headersSent) res.writeHead(500)
			res.end()
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return url
}

describe("a create that acknowledges without echoing the record", () => {
	it("tracks each record by the id it submitted and finds no defect", async () => {
		const rows = new Map<string, Row>()
		const url = await serve(rows)
		const result = await run({
			baseUrl: url,
			cohortSize: 3,
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.findings.filter((finding) => DEFECT_VERDICTS.has(finding.verdict))).toEqual([])
		const get = result.scope.operations.find((op) => op.operationId === "note.get")
		expect(get?.status).toBe("passed")
		const create = result.scope.operations.find((op) => op.operationId === "note.create")
		expect(create?.checks.passed).toContain("list.read-after-write")
	})

	it("tears down every record it created", async () => {
		const rows = new Map<string, Row>()
		const url = await serve(rows)
		await run({
			baseUrl: url,
			cohortSize: 3,
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect([...rows.keys()]).toEqual([])
	})

	it("does not claim the create discarded the fields it never echoed", async () => {
		const rows = new Map<string, Row>()
		const url = await serve(rows)
		const result = await run({
			baseUrl: url,
			cohortSize: 3,
			principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const create = result.scope.operations.find((op) => op.operationId === "note.create")
		expect(create?.checks.failed ?? []).not.toContain("create.persists-submitted-fields")
	})
})
