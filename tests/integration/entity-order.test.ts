import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Entities that share nothing are tested side by side, so they finish in whatever order the
 * backend answers. The result and the reports still list them in plan order: two runs of the same
 * document must read the same, and a test that compares them must not depend on timing.
 */

const ITEM = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

function paths(name: string, plural: string): NonNullable<OpenApiDocument["paths"]> {
	const entity = (action: string) => ({ "x-entity": { action, identity: "id", name } })
	return {
		[`/v1/${plural}`]: {
			get: {
				operationId: `${name}.list`,
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { properties: { items: { items: ITEM, type: "array" } }, required: ["items"], type: "object" },
							},
						},
						description: "ok",
					},
				},
				...entity("list"),
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
				responses: { "201": { content: { "application/json": { schema: ITEM } }, description: "created" } },
				...entity("create"),
			},
		},
		[`/v1/${plural}/{id}`]: {
			delete: { operationId: `${name}.delete`, responses: { "204": { description: "gone" } }, ...entity("delete") },
			get: {
				operationId: `${name}.read`,
				responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
				...entity("read"),
			},
		},
	}
}

const SPEC = {
	info: { title: "order", version: "1" },
	openapi: "3.1.0",
	paths: { ...paths("apple", "apples"), ...paths("banana", "bananas") },
} as OpenApiDocument

function send(res: ServerResponse, status: number, body?: unknown): void {
	const text = body === undefined ? "" : JSON.stringify(body)
	res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
	res.end(text)
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			resolve(text === "" ? {} : (JSON.parse(text) as Record<string, unknown>))
		})
	})
}

const hits: Array<{ at: number; entity: string }> = []
let url = ""
let close: () => Promise<void> = async () => {}

afterAll(() => close())

type World = { seq: number; stores: Record<"apple" | "banana", Map<string, unknown>> }

async function createFruit(world: World, entity: "apple" | "banana", req: IncomingMessage, res: ServerResponse) {
	const body = await readJson(req)
	world.seq += 1
	const row = { id: `${entity}_${world.seq}`, name: String(body.name ?? "n") }
	world.stores[entity].set(row.id, row)
	send(res, 201, row)
}

function fruitItem(store: Map<string, unknown>, id: string, method: string, res: ServerResponse): void {
	if (method === "GET") return store.has(id) ? send(res, 200, store.get(id)) : send(res, 404, {})
	if (method !== "DELETE") return send(res, 405)
	store.delete(id)
	send(res, 204)
}

async function route(world: World, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const at = new URL(req.url ?? "/", "http://x")
	const method = req.method ?? "GET"
	if (at.pathname === "/v1/openapi/spec") return send(res, 200, SPEC)
	const match = /^\/v1\/(apples|bananas)(?:\/([^/]+))?$/.exec(at.pathname)
	if (match === null) return send(res, 404, { error: "missing" })
	const entity = match[1] === "apples" ? "apple" : "banana"
	const store = world.stores[entity]
	const id = match[2]
	hits.push({ at: Date.now(), entity })
	/* The entity planned first answers slowly, so it finishes last. */
	if (entity === "apple") await new Promise((resolve) => setTimeout(resolve, 60))
	if (id === undefined && method === "GET") return send(res, 200, { items: [...store.values()] })
	if (id === undefined && method === "POST") return createFruit(world, entity, req, res)
	fruitItem(store, id ?? "", method, res)
}

async function start(): Promise<void> {
	const world: World = { seq: 0, stores: { apple: new Map(), banana: new Map() } }
	const server = createServer((req, res) => {
		void route(world, req, res)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	close = () => new Promise((resolve) => server.close(() => resolve()))
}

describe("entity order", () => {
	it("lists entities in plan order however their lanes finish, and still runs them side by side", async () => {
		await start()
		const result = await run({
			baseUrl: url,
			only: ["apple", "banana"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})
		expect(result.entitiesTested).toEqual(["apple", "banana"])
		const apple = hits.filter((hit) => hit.entity === "apple").map((hit) => hit.at)
		const banana = hits.filter((hit) => hit.entity === "banana").map((hit) => hit.at)
		/* Side by side: banana was being tested before apple was done. */
		expect(Math.min(...banana)).toBeLessThan(Math.max(...apple))
	}, 120_000)
})
