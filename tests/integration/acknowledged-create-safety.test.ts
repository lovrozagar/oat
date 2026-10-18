import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A create that asks for a client-chosen integer id, ignores it, stores the record under an id of
 * its own and answers only `{ success: true }`. Another tenant's rows hold the ids 1–60 and, as on
 * backends with weak item isolation, answer a GET or DELETE by id from anyone.
 *
 * oat sent those ids but never created anything under them. Nothing it does may touch those rows.
 */

type Row = { id: number; name: string; owner: string }

const FOREIGN = 60
const OWN_IDS_FROM = 100
const CALLER = "alpha"

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

function spec(withUpdate: boolean): OpenApiDocument {
	const note = {
		additionalProperties: false,
		properties: {
			id: { maximum: FOREIGN, minimum: 1, type: "integer" },
			name: { minLength: 1, type: "string" },
		},
		required: ["id", "name"],
		type: "object",
	}
	const ack = {
		content: { "application/json": { schema: { properties: { success: { type: "boolean" } }, type: "object" } } },
		description: "ok",
	}
	const idParam = [{ in: "path", name: "noteId", required: true, schema: { type: "integer" } }]
	return {
		info: { title: "ignored-client-id", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					responses: {
						"200": { content: { "application/json": { schema: { items: note, type: "array" } } }, description: "ok" },
					},
				},
				post: {
					operationId: "note.create",
					requestBody: { content: { "application/json": { schema: note } }, required: true },
					responses: { "200": ack, "400": { description: "invalid" } },
				},
			},
			"/notes/{noteId}": {
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
				...(withUpdate
					? {
							put: {
								operationId: "note.update",
								parameters: idParam,
								requestBody: { content: { "application/json": { schema: note } }, required: true },
								responses: { "200": ack, "400": { description: "invalid" }, "404": { description: "missing" } },
							},
						}
					: {}),
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

/* Names a validator would refuse: the payload probes send control characters. */
function hasControlCharacter(text: string): boolean {
	return [...text].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)
}

async function serve(rows: Map<number, Row>, options: { withUpdate: boolean }): Promise<string> {
	const document = spec(options.withUpdate)
	let nextId = OWN_IDS_FROM
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi.json") return send(res, 200, document)
			if (url.pathname === "/notes" && method === "GET") {
				return send(
					res,
					200,
					[...rows.values()].filter((row) => row.owner === CALLER),
				)
			}
			if (url.pathname === "/notes" && method === "POST") {
				const body = (await readJson(req)) as Partial<Row> | undefined
				if (typeof body?.name !== "string" || body.name === "" || hasControlCharacter(body.name)) {
					return send(res, 400, { success: false })
				}
				const id = nextId++
				rows.set(id, { id, name: body.name, owner: CALLER })
				return send(res, 200, { success: true })
			}
			const item = url.pathname.match(/^\/notes\/([^/]+)$/)
			if (item === null) return send(res, 404, {})
			const id = Number(decodeURIComponent(item[1] ?? ""))
			const row = rows.get(id)
			if (method === "GET") return row === undefined ? send(res, 404, {}) : send(res, 200, row)
			if (method === "PUT" && options.withUpdate) {
				const body = (await readJson(req)) as Partial<Row> | undefined
				if (row === undefined) return send(res, 404, {})
				if (typeof body?.name !== "string" || body.name === "") return send(res, 400, { success: false })
				rows.set(id, { ...row, name: body.name })
				return send(res, 200, { success: true })
			}
			if (method === "DELETE") return rows.delete(id) ? send(res, 200, { success: true }) : send(res, 404, {})
			return send(res, 405, {})
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

function foreignRows(): Map<number, Row> {
	const rows = new Map<number, Row>()
	for (let id = 1; id <= FOREIGN; id++) rows.set(id, { id, name: `foreign-${id}`, owner: "beta" })
	return rows
}

function untouchedForeign(rows: Map<number, Row>): number {
	let untouched = 0
	for (let id = 1; id <= FOREIGN; id++) {
		const row = rows.get(id)
		if (row?.owner === "beta" && row.name === `foreign-${id}`) untouched++
	}
	return untouched
}

async function runAgainst(url: string): Promise<void> {
	await run({
		baseUrl: url,
		cohortSize: 3,
		principals: [{ headers: { authorization: `Bearer ${CALLER}` }, id: CALLER }],
		seed: 1,
		spec: `${url}/openapi.json`,
	})
}

describe("a create that ignores the client's id and only acknowledges", () => {
	it("never deletes or changes a row it did not create", async () => {
		const rows = foreignRows()
		await runAgainst(await serve(rows, { withUpdate: true }))
		expect(untouchedForeign(rows)).toBe(FOREIGN)
	})

	it("never deletes or changes a row it did not create when payloads are written through the create", async () => {
		const rows = foreignRows()
		await runAgainst(await serve(rows, { withUpdate: false }))
		expect(untouchedForeign(rows)).toBe(FOREIGN)
	})
})
