import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { report } from "../src/report/console.ts"
import { run } from "../src/runtime/run.ts"
import { readUnique } from "../src/spec/extensions.ts"
import { buildModel } from "../src/spec/graph.ts"
import type { OpenApiDocument, OperationObject } from "../src/spec/types.ts"

const ITEM = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

function widgetDoc(tag: unknown | undefined): OpenApiDocument {
	const create: Record<string, unknown> = {
		operationId: "widget.create",
		requestBody: {
			content: {
				"application/json": {
					schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
				},
			},
			required: true,
		},
		responses: {
			"201": { content: { "application/json": { schema: ITEM } }, description: "created" },
			"409": {
				content: { "application/json": { schema: { properties: { error_key: { type: "string" } }, type: "object" } } },
				description: "conflict",
			},
		},
		"x-entity": { action: "create", identity: "id", name: "widget" },
	}
	if (tag !== undefined) create["x-unique"] = tag
	return {
		info: { title: "unique", version: "1" },
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
										properties: { widgets: { items: ITEM, type: "array" } },
										required: ["widgets"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "widget" },
				},
				post: create,
			},
			"/v1/widgets/{id}": {
				delete: {
					operationId: "widget.delete",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					responses: { "204": { description: "gone" } },
					"x-entity": { action: "delete", identity: "id", name: "widget" },
				},
				get: {
					operationId: "widget.read",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
					"x-entity": { action: "read", identity: "id", name: "widget" },
				},
				patch: {
					operationId: "widget.update",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					requestBody: {
						content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
					},
					responses: {
						"200": { content: { "application/json": { schema: ITEM } }, description: "ok" },
						"409": {
							content: {
								"application/json": { schema: { properties: { error_key: { type: "string" } }, type: "object" } },
							},
							description: "conflict",
						},
					},
					"x-entity": { action: "update", identity: "id", name: "widget" },
					...(tag === undefined ? {} : { "x-unique": tag }),
				},
			},
		},
	} as OpenApiDocument
}

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

async function serve(options: {
	duplicate: "409" | "201"
	tag?: unknown
	seed409?: boolean
	seeded?: boolean
}): Promise<{ close: () => Promise<void>; url: string }> {
	const document = widgetDoc(options.tag)
	const rows = new Map<string, { id: string; name: string }>()
	let seq = 0
	let posts = 0
	if (options.seeded === true) rows.set("w_existing", { id: "w_existing", name: "Existing" })

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, document)
			if (url.pathname === "/v1/widgets" && method === "GET") return send(res, 200, { widgets: [...rows.values()] })
			if (url.pathname === "/v1/widgets" && method === "POST") {
				const body = ((await readJson(req)) ?? {}) as { name?: string }
				posts += 1
				if (options.seed409 === true && posts === 1) return send(res, 409, { error_key: "conflict" })
				const name = typeof body.name === "string" ? body.name : ""
				if ([...rows.values()].some((row) => row.name === name)) {
					if (options.duplicate === "409") return send(res, 409, { error_key: "conflict" })
				}
				const id = `w_${String((seq += 1))}`
				const row = { id, name }
				rows.set(id, row)
				return send(res, 201, row)
			}
			const item = /^\/v1\/widgets\/([^/]+)$/.exec(url.pathname)
			if (item !== null && method === "GET") {
				const row = rows.get(decodeURIComponent(item[1] ?? ""))
				return row === undefined ? send(res, 404) : send(res, 200, row)
			}
			if (item !== null && method === "PATCH") {
				const id = decodeURIComponent(item[1] ?? "")
				const row = rows.get(id)
				if (row === undefined) return send(res, 404)
				const body = ((await readJson(req)) ?? {}) as { name?: string }
				if (typeof body.name === "string") {
					if ([...rows.values()].some((other) => other.id !== id && other.name === body.name)) {
						if (options.duplicate === "409") return send(res, 409, { error_key: "conflict" })
					}
					row.name = body.name
				}
				return send(res, 200, row)
			}
			if (item !== null && method === "DELETE") {
				rows.delete(decodeURIComponent(item[1] ?? ""))
				return send(res, 204)
			}
			return send(res, 404)
		})().catch(() => {
			if (!res.headersSent) send(res, 500)
		})
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
		url: `http://127.0.0.1:${addr.port}`,
	}
}

const worlds: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
	await Promise.all(worlds.splice(0).map((w) => w.close()))
})

describe("x-unique", () => {
	it("parses list-of-sets, {columns}, and a single string[] the same way", () => {
		expect(readUnique({ "x-unique": [["email"], ["workspace_id", "slug"]] } as OperationObject)).toEqual([
			["email"],
			["workspace_id", "slug"],
		])
		expect(
			readUnique({ "x-unique": [{ columns: ["email"] }, { columns: ["workspace_id", "slug"] }] } as OperationObject),
		).toEqual([["email"], ["workspace_id", "slug"]])
		expect(readUnique({ "x-unique": ["email"] } as OperationObject)).toEqual([["email"]])
		expect(readUnique({ "x-unique": [[], ["name"], []] } as OperationObject)).toEqual([["name"]])
		expect(readUnique({ "x-unique": [] } as OperationObject)).toEqual([])
		expect(readUnique({} as OperationObject)).toBeNull()
		expect(readUnique({ "x-unique": { no: true } } as OperationObject)).toBeNull()
	})

	it("buildModel records a gap for malformed x-unique and lists sets on doctor/plan", () => {
		const bad = buildModel({
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/widgets": {
					post: {
						operationId: "widget.create",
						responses: { "201": { description: "ok" } },
						"x-entity": { action: "create", identity: "id", name: "widget" },
						"x-unique": "name",
					},
				},
			},
		} as OpenApiDocument)
		expect(bad.byOperationId.get("widget.create")?.unique).toBeNull()
		expect(bad.gaps.gaps.some((gap) => gap.tag === "x-unique")).toBe(true)

		const good = buildModel(widgetDoc([["name"]]))
		expect(good.entities.get("widget")?.unique).toEqual([["name"]])
		const plan = report.plan(good, false)
		const doctor = report.doctor(good, [], false)
		expect(plan).toContain("x-unique:")
		expect(plan).toContain("[name]")
		expect(doctor.text).toContain("x-unique:")
		expect(doctor.text).toContain("[name]")
	})

	it("409 duplicate create is not BACKEND_BUG; 201 duplicate is", async () => {
		const pass = await serve({ duplicate: "409", tag: [["name"]] })
		worlds.push(pass)
		const passed = await run({
			baseUrl: pass.url,
			only: ["widget"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${pass.url}/v1/openapi/spec`,
		})
		expect(passed.checksRun).toContain("create.unique-conflict-rejected")
		expect(
			passed.findings.some((f) => f.check === "create.unique-conflict-rejected" && f.verdict === "BACKEND_BUG"),
		).toBe(false)

		const fail = await serve({ duplicate: "201", tag: [["name"]] })
		worlds.push(fail)
		const failed = await run({
			baseUrl: fail.url,
			only: ["widget"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${fail.url}/v1/openapi/spec`,
		})
		expect(
			failed.findings.some((f) => f.check === "create.unique-conflict-rejected" && f.verdict === "BACKEND_BUG"),
		).toBe(true)
	})

	it("missing tag does not run the check; untagged 409 is a seed failure", async () => {
		const world = await serve({ duplicate: "409", seed409: true })
		worlds.push(world)
		const result = await run({
			baseUrl: world.url,
			only: ["widget"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${world.url}/v1/openapi/spec`,
		})
		expect(result.checksRun).not.toContain("create.unique-conflict-rejected")
		const seed = result.findings.find((f) => f.check === "world.seed")
		expect(seed?.verdict).toBe("BLOCKED")
		expect(seed?.detail.includes("x-unique") ?? false).toBe(false)
	})

	it("tagged seed 409 with a nonempty list adopts and still runs the unique check", async () => {
		const world = await serve({ duplicate: "409", seed409: true, seeded: true, tag: [["name"]] })
		worlds.push(world)
		const result = await run({
			baseUrl: world.url,
			only: ["widget"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${world.url}/v1/openapi/spec`,
		})
		const seed = result.findings.find((f) => f.check === "world.seed")
		expect(seed?.verdict).toBe("COVERAGE_GAP")
		expect(seed?.detail).toContain("x-unique")
		expect(result.checksRun).toContain("create.unique-conflict-rejected")
		expect(
			result.findings.some((f) => f.check === "create.unique-conflict-rejected" && f.verdict === "BACKEND_BUG"),
		).toBe(false)
	})
})
