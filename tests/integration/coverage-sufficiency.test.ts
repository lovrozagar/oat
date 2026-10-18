import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A pass says how far it goes. A read with no effects has nothing to prove beyond its contract:
 * that is complete. A write proves itself only by an effect a later read observes: without one it
 * is unproven, however clean its response. A route can declare it has no effects (`x-effects: []`)
 * and then its contract is complete too.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

const object = { "application/json": { schema: { type: "object" } } }
const ok = { "200": { content: object, description: "ok" } }
const item = {
	properties: { id: { readOnly: true, type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}
const spec: OpenApiDocument = {
	info: { title: "sufficiency", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/health": { get: { operationId: "health.get", responses: ok } },
		"/v1/notify": { post: { operationId: "notify.send", responses: ok } },
		"/v1/uuid": { post: { operationId: "uuid.generate", responses: ok, "x-effects": [] } },
		"/v1/notes": {
			get: {
				operationId: "note.list",
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { properties: { notes: { items: item, type: "array" } }, type: "object" },
							},
						},
						description: "ok",
					},
				},
			},
			post: {
				operationId: "note.create",
				requestBody: {
					content: {
						"application/json": {
							schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
						},
					},
				},
				responses: {
					"201": { content: { "application/json": { schema: item } }, description: "created" },
					"400": { content: object, description: "invalid" },
				},
			},
		},
		"/v1/notes/{id}": {
			delete: {
				operationId: "note.delete",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { "204": { description: "deleted" }, "404": { content: object, description: "missing" } },
			},
			get: {
				operationId: "note.get",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { "200": { content: { "application/json": { schema: item } }, description: "ok" } },
			},
		},
	},
} as OpenApiDocument

async function serve(): Promise<string> {
	const notes = new Map<string, { id: string; name: string }>()
	let seq = 0
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const send = (status: number, body?: unknown) => {
			res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
			res.end(body === undefined ? undefined : JSON.stringify(body))
		}
		void (async () => {
			const path = new URL(req.url ?? "/", "http://x").pathname
			const method = req.method ?? "GET"
			if (path === "/openapi.json") return send(200, spec)
			if (path === "/v1/notes" && method === "POST") {
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { name?: unknown }
				if (typeof body.name !== "string") return send(400, { error: "name is required" })
				const note = { id: `n${String((seq += 1))}`, name: body.name }
				notes.set(note.id, note)
				return send(201, note)
			}
			if (path === "/v1/notes") return send(200, { notes: [...notes.values()] })
			const id = /^\/v1\/notes\/(.+)$/.exec(path)?.[1]
			if (id !== undefined && method === "DELETE") {
				if (!notes.delete(id)) return send(404, {})
				return send(204)
			}
			if (id !== undefined) return notes.has(id) ? send(200, notes.get(id)) : send(404, {})
			return send(200, { ok: true })
		})()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("how far a pass goes", () => {
	it("calls an effect-free read complete, an unobserved write unproven, and an observed one verified", async () => {
		const url = await serve()
		const result = await run({
			baseUrl: url,
			principals: [{ headers: {}, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		const row = (id: string) => result.scope.operations.find((op) => op.operationId === id)
		expect(row("health.get")).toMatchObject({ status: "passed", sufficiency: "complete" })
		expect(row("uuid.generate")).toMatchObject({ status: "passed", sufficiency: "complete" })
		expect(row("notify.send")).toMatchObject({ status: "passed", sufficiency: "unproven" })
		expect(row("note.create")).toMatchObject({ status: "passed", sufficiency: "verified" })
		for (const id of ["health.get", "uuid.generate", "notify.send", "note.create"]) {
			expect(row(id)?.why).toEqual(expect.any(String))
		}
	})
})
