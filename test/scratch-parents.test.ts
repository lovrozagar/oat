import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

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

async function startWorld() {
	/* Records by collection path; any path works, so one handler serves all three kinds. */
	const rows = new Map<string, Map<string, Record<string, unknown>>>()
	const hits: Array<{ at: number; kind: string; parent: string | undefined }> = []
	let seq = 0
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			const send = (status: number, body?: unknown) => {
				if (body === undefined) return res.writeHead(status).end()
				res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
			}
			const path = new URL(req.url ?? "/", "http://x").pathname
			if (path === "/v1/openapi/spec") return send(200, SPEC)
			const parts = path.split("/").filter(Boolean)
			const kind = parts.length >= 4 ? (parts[3] ?? "") : (parts[1] ?? "")
			hits.push({ at: performance.now(), kind, parent: parts.length >= 4 ? parts[2] : undefined })
			const isItem = ["parents", "apples", "bananas"].includes(parts.at(-2) ?? "")
			const base = `/${(isItem ? parts.slice(0, -1) : parts).join("/")}`
			const store = rows.get(base) ?? new Map<string, Record<string, unknown>>()
			rows.set(base, store)
			if (!isItem && req.method === "GET") return send(200, { items: [...store.values()] })
			if (!isItem && req.method === "POST") {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>
				const record = { ...body, id: `r${(seq += 1)}` }
				store.set(record.id, record)
				return send(201, record)
			}
			const id = parts.at(-1) ?? ""
			const record = store.get(id)
			if (record === undefined) return send(404, { error: "not found" })
			if (req.method === "GET") return send(200, record)
			if (req.method === "DELETE") {
				store.delete(id)
				return send(204)
			}
			return send(405, { error: "method" })
		})
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
