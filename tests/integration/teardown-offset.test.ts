import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A list paged by offset counts the rows it served, not the distinct records among them. A list
 * that serves a record twice — a join that repeats it — still skips by rows, so the re-list after
 * teardown asks for the next offset by rows served.
 */

const PAGE = 3
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const NOTE = { properties: { id: { readOnly: true, type: "string" }, text: { type: "string" } }, type: "object" }
const ID = [{ in: "path", name: "id", required: true, schema: { type: "string" } }]
const entity = (action: string) => ({ "x-entity": { action, name: "note" } })

const SPEC = {
	info: { title: "teardown-offset", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/notes": {
			get: {
				operationId: "note.list",
				parameters: [
					{ in: "query", name: "offset", schema: { minimum: 0, type: "integer" } },
					{ in: "query", name: "limit", schema: { maximum: PAGE, minimum: 1, type: "integer" } },
				],
				responses: { "200": { ...json({ properties: { items: { items: NOTE, type: "array" } } }), description: "ok" } },
				...entity("list"),
			},
			post: {
				operationId: "note.create",
				requestBody: { ...json({ properties: { text: { type: "string" } }, type: "object" }), required: true },
				responses: { "201": { ...json(NOTE), description: "created" } },
				...entity("create"),
			},
		},
		"/notes/{id}": {
			delete: {
				operationId: "note.delete",
				parameters: ID,
				responses: { "204": { description: "gone" } },
				...entity("delete"),
			},
			get: {
				operationId: "note.read",
				parameters: ID,
				responses: { "200": { ...json(NOTE), description: "ok" } },
				...entity("read"),
			},
		},
	},
} as unknown as OpenApiDocument

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

describe("the re-list after teardown, over an offset-paged list", () => {
	it("advances by the rows each page served, repeats included", async () => {
		const notes: Array<{ id: string; text: string }> = []
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://x")
			const send = (status: number, body?: unknown) => {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(body === undefined ? "" : JSON.stringify(body))
			}
			if (url.pathname === "/openapi.json") return send(200, SPEC)
			if (url.pathname === "/notes" && req.method === "GET") {
				/* Every note served twice, as a join that repeats it would. */
				const rows = notes.flatMap((note) => [note, note])
				const offset = Number(url.searchParams.get("offset") ?? 0)
				const limit = Math.min(Number(url.searchParams.get("limit") ?? PAGE), PAGE)
				return send(200, { items: rows.slice(offset, offset + limit) })
			}
			if (url.pathname === "/notes" && req.method === "POST") {
				let text = ""
				req.on("data", (chunk: Buffer) => {
					text += chunk.toString()
				})
				req.on("end", () => {
					const note = {
						id: `n${notes.length + 1}`,
						text: String((JSON.parse(text || "{}") as { text?: unknown }).text ?? ""),
					}
					notes.push(note)
					send(201, note)
				})
				return
			}
			const id = /^\/notes\/([^/]+)$/.exec(url.pathname)?.[1]
			const note = notes.find((candidate) => candidate.id === id)
			if (note === undefined) return send(404, {})
			/* The delete answers success and keeps the note: the re-list must find it wherever it is. */
			if (req.method === "DELETE") return send(204)
			return send(200, note)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		closers.push(() => new Promise((resolve) => server.close(() => resolve())))
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		const result = await run({ baseUrl: base, principals: { alpha: {} }, seed: 1, spec: `${base}/openapi.json` })

		const offsets = result.client.transcript
			.filter((exchange) => exchange.purpose === "teardown" && exchange.method === "GET")
			.map((exchange) => Number(new URL(exchange.url).searchParams.get("offset") ?? 0))
		expect(offsets.length).toBeGreaterThan(1)
		expect(offsets.filter((offset) => offset % PAGE !== 0)).toEqual([])
	}, 120_000)
})
