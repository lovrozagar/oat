import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { isRootCause } from "../src/runtime/finding.ts"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * Some backends name the identity `ID` and wrap what a create made in an envelope:
 * `{ success, id, data: { ID, name } }`. The record is the object under `data`, its identity is
 * `ID` — or the top-level `id` when `data` leaves it out. Taking the envelope for the record made
 * oat compare the wrong object and lose the id it needs to read back and remove what it created.
 */

const ITEM = {
	properties: { ID: { readOnly: true, type: "string" }, name: { type: "string" }, note: { type: "string" } },
	required: ["ID", "name"],
	type: "object",
}

const entity = (action: string) => ({ "x-entity": { action, identity: "ID", name: "widget" } })

/* Every refusal is documented, so a correct fixture draws no "undeclared status" finding. */
const REFUSED = { default: { description: "refused" } }

function spec(innerHasId: boolean): OpenApiDocument {
	/* With the id only on the envelope, the record under `data` does not carry it. */
	const created = innerHasId ? ITEM : { ...ITEM, required: ["name"] }
	return {
		info: { title: "envelope", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/widgets": {
				get: {
					operationId: "widget.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { items: { items: ITEM, type: "array" } },
										required: ["items"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
						...REFUSED,
					},
					...entity("list"),
				},
				post: {
					operationId: "widget.create",
					requestBody: {
						content: {
							"application/json": {
								schema: {
									properties: { name: { type: "string" }, note: { type: "string" } },
									required: ["name"],
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
										properties: { data: created, id: { type: "string" }, success: { type: "boolean" } },
										required: ["success", "id", "data"],
										type: "object",
									},
								},
							},
							description: "created",
						},
						...REFUSED,
					},
					...entity("create"),
				},
			},
			"/v1/widgets/{ID}": {
				delete: {
					operationId: "widget.delete",
					parameters: [{ in: "path", name: "ID", required: true, schema: { type: "string" } }],
					responses: { "204": { description: "gone" }, ...REFUSED },
					...entity("delete"),
				},
				get: {
					operationId: "widget.read",
					parameters: [{ in: "path", name: "ID", required: true, schema: { type: "string" } }],
					responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" }, ...REFUSED },
					...entity("read"),
				},
			},
		},
	} as unknown as OpenApiDocument
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
	res.end(body === undefined ? "" : JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			try {
				const parsed: unknown = text === "" ? {} : JSON.parse(text)
				resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {})
			} catch (error) {
				reject(error)
			}
		})
	})
}

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(servers.splice(0).map((close) => close()))
})

async function serve(innerHasId: boolean) {
	const store = new Map<string, Record<string, unknown>>()
	let seq = 0
	const server = createServer((req, res) => {
		void (async () => {
			const at = new URL(req.url ?? "/", "http://x")
			const method = req.method ?? "GET"
			if (at.pathname === "/v1/openapi/spec") return send(res, 200, spec(innerHasId))
			const match = /^\/v1\/widgets(?:\/([^/]+))?$/.exec(at.pathname)
			if (match === null) return send(res, 404, { error: "missing" })
			const id = match[1] === undefined ? undefined : decodeURIComponent(match[1])
			if (id === undefined && method === "GET") return send(res, 200, { items: [...store.values()] })
			if (id === undefined && method === "POST") {
				if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
					return send(res, 415, { error: "json only" })
				}
				const body = await readJson(req).catch(() => null)
				if (body === null || typeof body.name !== "string") return send(res, 400, { error: "name is required" })
				if (body.note !== undefined && typeof body.note !== "string") return send(res, 400, { error: "note is text" })
				seq += 1
				const row = { ID: `W${seq}`, name: String(body.name ?? ""), note: String(body.note ?? "") }
				store.set(row.ID, row)
				const { ID, ...rest } = row
				return send(res, 201, { data: innerHasId ? row : rest, id: ID, success: true })
			}
			if (method === "GET") return store.has(id ?? "") ? send(res, 200, store.get(id ?? "")) : send(res, 404, {})
			if (method === "DELETE") {
				if (!store.delete(id ?? "")) return send(res, 404, {})
				return send(res, 204)
			}
			return send(res, 405)
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	servers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return { store, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function runAgainst(innerHasId: boolean) {
	const { store, url } = await serve(innerHasId)
	const result = await run({
		baseUrl: url,
		principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
		seed: 1,
		spec: `${url}/v1/openapi/spec`,
	})
	return { result, store }
}

describe("an enveloped create with an upper-case identity", () => {
	for (const innerHasId of [true, false]) {
		it(`seeds, reads back and removes every record${innerHasId ? "" : " when only the envelope names the id"}`, async () => {
			const { result, store } = await runAgainst(innerHasId)
			expect(result.findings.filter(isRootCause).map((finding) => `${finding.check}: ${finding.summary}`)).toEqual([])
			expect(result.checksRun).toContain("create.persists-submitted-fields")
			expect(result.teardown?.failed).toEqual([])
			expect([...store.values()]).toEqual([])
		}, 120_000)
	}
})
