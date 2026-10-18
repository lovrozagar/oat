import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/* Two collections nested under one parent kind, the parent itself not under test: each should get
 * its own scratch parent and run in its own lane. */

const item = {
	properties: { id: { type: "string" }, name: { type: "string" }, note: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}
const json = (schema: unknown) => ({ "application/json": { schema } })

function collection(name: string, base: string, param: string | null): NonNullable<OpenApiDocument["paths"]> {
	const parameters = param === null ? [] : [{ in: "path", name: param, required: true, schema: { type: "string" } }]
	const withId = [...parameters, { in: "path", name: "id", required: true, schema: { type: "string" } }]
	const tag = (action: string) => ({ action, identity: "id", name })
	return {
		[base]: {
			get: {
				operationId: `${name}.list`,
				parameters,
				responses: {
					"200": {
						content: json({
							properties: { items: { items: item, type: "array" } },
							required: ["items"],
							type: "object",
						}),
						description: "ok",
					},
				},
				"x-entity": tag("list"),
			},
			post: {
				operationId: `${name}.create`,
				parameters,
				requestBody: {
					content: json({ properties: { name: { type: "string" } }, required: ["name"], type: "object" }),
					required: true,
				},
				responses: { "201": { content: json(item), description: "created" } },
				"x-entity": tag("create"),
			},
		},
		[`${base}/{id}`]: {
			delete: {
				operationId: `${name}.delete`,
				parameters: withId,
				responses: { "204": { description: "gone" } },
				"x-entity": tag("delete"),
			},
			get: {
				operationId: `${name}.read`,
				parameters: withId,
				responses: { "200": { content: json(item), description: "ok" } },
				"x-entity": tag("read"),
			},
		},
	}
}

const SPEC = {
	info: { title: "siblings", version: "1" },
	openapi: "3.1.0",
	paths: {
		...collection("parent", "/v1/parents", null),
		...collection("apple", "/v1/parents/{parent_id}/apples", "parent_id"),
		...collection("banana", "/v1/parents/{parent_id}/bananas", "parent_id"),
	},
} as OpenApiDocument

type Send = (status: number, body?: unknown) => void
type Hit = { at: number; kind: string; parent: string | undefined }
type World = { hits: Hit[]; rows: Map<string, Map<string, Record<string, unknown>>>; seq: number }

function itemAnswer(store: Map<string, Record<string, unknown>>, id: string, method: string | undefined, send: Send) {
	const record = store.get(id)
	if (record === undefined) return send(404, { error: "not found" })
	if (method === "GET") return send(200, record)
	if (method !== "DELETE") return send(405, { error: "method" })
	store.delete(id)
	send(204)
}

/* A path under a parent names the kind after it; a top-level path names its own. */
function hitOf(parts: string[]): Hit {
	const nested = parts.length >= 4
	return { at: performance.now(), kind: (nested ? parts[3] : parts[1]) ?? "", parent: nested ? parts[2] : undefined }
}

/* Records by collection path; any path works, so one handler serves all three kinds. */
function answer(world: World, req: IncomingMessage, body: Buffer, send: Send): void {
	const path = new URL(req.url ?? "/", "http://x").pathname
	if (path === "/v1/openapi/spec") return send(200, SPEC)
	const parts = path.split("/").filter(Boolean)
	world.hits.push(hitOf(parts))
	const isItem = ["parents", "apples", "bananas"].includes(parts.at(-2) ?? "")
	const base = `/${(isItem ? parts.slice(0, -1) : parts).join("/")}`
	const store = world.rows.get(base) ?? new Map<string, Record<string, unknown>>()
	world.rows.set(base, store)
	if (!isItem && req.method === "GET") return send(200, { items: [...store.values()] })
	if (!isItem && req.method === "POST") {
		const fields = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>
		const record = { ...fields, id: `r${(world.seq += 1)}` }
		store.set(record.id, record)
		return send(201, record)
	}
	itemAnswer(store, parts.at(-1) ?? "", req.method, send)
}

async function startWorld() {
	const world: World = { hits: [], rows: new Map(), seq: 0 }
	const { hits } = world
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const send: Send = (status, body) => {
			if (body === undefined) res.writeHead(status).end()
			else res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
		}
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => answer(world, req, Buffer.concat(chunks), send))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return {
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		hits,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	}
}

describe("siblings under one parent kind", () => {
	it("each get their own scratch parent, and run side by side", async () => {
		const world = await startWorld()
		try {
			const result = await run({
				baseUrl: world.url,
				only: ["apple", "banana"],
				principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
				seed: 1,
				spec: `${world.url}/v1/openapi/spec`,
			})
			expect(result.entitiesTested.sort()).toEqual(["apple", "banana"])
			const parentsOf = (kind: string) =>
				new Set(world.hits.filter((hit) => hit.kind === kind).map((hit) => hit.parent))
			const apples = parentsOf("apples")
			const bananas = parentsOf("bananas")
			expect(apples.size).toBeGreaterThan(0)
			expect([...apples].some((parent) => bananas.has(parent))).toBe(false)
			const span = (kind: string) => world.hits.filter((hit) => hit.kind === kind).map((hit) => hit.at)
			expect(Math.min(...span("bananas"))).toBeLessThan(Math.max(...span("apples")))
		} finally {
			await world.close()
		}
	}, 60_000)
})
