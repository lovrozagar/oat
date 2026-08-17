import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { CHECKS } from "../src/runtime/checks.ts"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-length": String(Buffer.byteLength(text)), "content-type": "application/json" })
	res.end(text)
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
		})
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			if (text === "") {
				resolve(undefined)
				return
			}
			try {
				resolve(JSON.parse(text) as unknown)
			} catch (error) {
				reject(error)
			}
		})
		req.on("error", reject)
	})
}

function itemSchema(): Record<string, unknown> {
	return {
		properties: {
			id: { type: "string" },
			name: { type: "string" },
			note: { type: "string" },
		},
		required: ["id", "name"],
		type: "object",
	}
}

function entityPaths(name: string, plural: string): NonNullable<OpenApiDocument["paths"]> {
	const collection = {
		type: "object",
		properties: { items: { items: itemSchema(), type: "array" } },
		required: ["items"],
	}
	return {
		[`/v1/${plural}`]: {
			get: {
				operationId: `${name}.list`,
				responses: { "200": { content: { "application/json": { schema: collection } }, description: "ok" } },
				"x-entity": { action: "list", identity: "id", name },
			},
			post: {
				operationId: `${name}.create`,
				requestBody: {
					content: {
						"application/json": {
							schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
						},
					},
					required: true,
				},
				responses: { "201": { content: { "application/json": { schema: itemSchema() } }, description: "created" } },
				"x-entity": { action: "create", identity: "id", name },
			},
		},
		[`/v1/${plural}/{id}`]: {
			delete: {
				operationId: `${name}.delete`,
				responses: { "204": { description: "gone" } },
				"x-entity": { action: "delete", identity: "id", name },
			},
			get: {
				operationId: `${name}.read`,
				responses: { "200": { content: { "application/json": { schema: itemSchema() } }, description: "ok" } },
				"x-entity": { action: "read", identity: "id", name },
			},
			patch: {
				operationId: `${name}.update`,
				requestBody: {
					content: {
						"application/json": {
							schema: { properties: { name: { type: "string" }, note: { type: "string" } }, type: "object" },
						},
					},
				},
				responses: { "200": { content: { "application/json": { schema: itemSchema() } }, description: "ok" } },
				"x-entity": { action: "update", identity: "id", name },
			},
		},
	}
}

const SPEC = {
	info: { title: "serial-entities", version: "1" },
	openapi: "3.1.0",
	paths: {
		...entityPaths("apple", "apples"),
		...entityPaths("banana", "bananas"),
	},
} as OpenApiDocument

interface Hit {
	at: number
	entity: string
	method: string
	path: string
}

async function startWorld(): Promise<{
	close: () => Promise<void>
	hits: Hit[]
	overlap: boolean
	url: string
}> {
	const stores = {
		apple: new Map<string, { id: string; name: string; note: string }>(),
		banana: new Map<string, { id: string; name: string; note: string }>(),
	}
	const hits: Hit[] = []
	const inflight = new Set<string>()
	let overlap = false
	let seq = 0

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, SPEC)

			const match = /^\/v1\/(apples|bananas)(?:\/([^/]+))?$/.exec(url.pathname)
			if (match === null) return send(res, 404, { error: "missing" })
			const entity = match[1] === "apples" ? "apple" : "banana"
			const id = match[2]
			const store = stores[entity]

			inflight.add(entity)
			for (const other of inflight) {
				if (other !== entity) overlap = true
			}
			hits.push({ at: Date.now(), entity, method, path: url.pathname })

			try {
				if (id === undefined && method === "GET") {
					return send(res, 200, { items: [...store.values()] })
				}
				if (id === undefined && method === "POST") {
					const body = ((await readJson(req)) ?? {}) as { name?: string; note?: string }
					seq += 1
					const row = { id: `${entity}_${seq}`, name: body.name ?? "n", note: body.note ?? "" }
					store.set(row.id, row)
					return send(res, 201, row)
				}
				if (id !== undefined && method === "GET") {
					const row = store.get(id)
					return row === undefined ? send(res, 404, { error: "missing" }) : send(res, 200, row)
				}
				if (id !== undefined && method === "PATCH") {
					const row = store.get(id)
					if (row === undefined) return send(res, 404, { error: "missing" })
					const body = ((await readJson(req)) ?? {}) as { name?: string; note?: string }
					const next = { ...row, ...body }
					store.set(id, next)
					return send(res, 200, next)
				}
				if (id !== undefined && method === "DELETE") {
					store.delete(id)
					return send(res, 204)
				}
				return send(res, 405)
			} finally {
				inflight.delete(entity)
			}
		})()
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		hits,
		get overlap() {
			return overlap
		},
		url: `http://127.0.0.1:${addr.port}`,
	}
}

const worlds: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
	await Promise.all(worlds.splice(0).map((w) => w.close()))
})

describe("serial entities", () => {
	it("starts entity B only after entity A’s last request (plan order)", async () => {
		const world = await startWorld()
		worlds.push(world)

		const result = await run({
			baseUrl: world.url,
			keepFixtures: true,
			only: ["apple", "banana"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${world.url}/v1/openapi/spec`,
		})

		expect(result.entitiesTested).toEqual(["apple", "banana"])
		const apple = world.hits.filter((h) => h.entity === "apple")
		const banana = world.hits.filter((h) => h.entity === "banana")
		expect(apple.length).toBeGreaterThan(0)
		expect(banana.length).toBeGreaterThan(0)
		const lastApple = Math.max(...apple.map((h) => h.at))
		const firstBanana = Math.min(...banana.map((h) => h.at))
		expect(firstBanana).toBeGreaterThanOrEqual(lastApple)
		expect(world.overlap).toBe(false)
	})

	it("still registers concurrency.no-lost-update", () => {
		expect(CHECKS.some((check) => check.id === "concurrency.no-lost-update")).toBe(true)
	})
})
