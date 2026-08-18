import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "../src/runtime/client.ts"
import {
	createProgressPump,
	formatProgressJsonl,
	formatProgressLine,
	formatProgressTsv,
	HEARTBEAT_MS,
	PROGRESS_TSV_HEADER,
	progressEventKey,
	type ProgressSnapshot,
} from "../src/runtime/progress.ts"
import { run } from "../src/runtime/run.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

const EXTRACT = "http://127.0.0.1/v1/projects/p1/extract"

function snap(over: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
	return {
		check: "effects.declared-effect-occurs",
		elapsedMs: 4_000,
		entity: "project",
		findings: 0,
		phase: "test",
		requests: 7,
		...over,
	}
}

function field(line: string, key: string): string | undefined {
	const match = new RegExp(`(?:^|\\s)${key}=("(?:[^"\\\\]|\\\\.)*"|\\S+)`).exec(line)
	if (match?.[1] === undefined) return undefined
	const raw = match[1]
	return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
}

describe("in-flight progress format", () => {
	it("uses status=in_flight and the live path, not the last completed call", () => {
		const started = Date.parse("2026-08-18T12:00:00.000Z")
		const line = formatProgressLine(
			snap({
				inflight: { at: started, method: "POST", requestBytes: 120, url: EXTRACT },
				last: {
					at: started - 2_000,
					durationMs: 40,
					method: "POST",
					requestBytes: 80,
					requestId: "",
					responseBytes: 40,
					status: 200,
					url: "http://127.0.0.1/v1/auth/refresh",
				},
			}),
			started + 3_500,
		)
		expect(field(line, "status")).toBe("in_flight")
		expect(field(line, "method")).toBe("POST")
		expect(field(line, "path")).toBe("/v1/projects/p1/extract")
		expect(field(line, "http")).toBe("-")
		expect(field(line, "last_ms")).toBe("-")
		expect(field(line, "res_b")).toBe("-")
		expect(field(line, "idle_ms")).toBe("3500")
		expect(field(line, "check")).toBe("effects.declared-effect-occurs")
		expect(field(line, "msg")).toBe("-")
	})

	it("does not treat a long in-flight call as stall", () => {
		const now = 20_000
		const line = formatProgressLine(snap({ inflight: { at: 0, method: "POST", url: EXTRACT } }), now)
		expect(field(line, "status")).toBe("in_flight")
		expect(field(line, "idle_ms")).toBe("20000")
	})

	it("keeps the in-flight path while idle_ms climbs", () => {
		const live = snap({ inflight: { at: 1_000, method: "POST", url: EXTRACT } })
		const early = formatProgressLine(live, 2_000)
		const later = formatProgressLine(live, 8_000)
		expect(field(early, "path")).toBe("/v1/projects/p1/extract")
		expect(field(later, "path")).toBe("/v1/projects/p1/extract")
		expect(field(early, "idle_ms")).toBe("1000")
		expect(field(later, "idle_ms")).toBe("7000")
	})

	it("emits a completed line with http, last_ms, and idle_ms=0", () => {
		const at = Date.parse("2026-08-18T12:00:10.000Z")
		const line = formatProgressLine(
			snap({
				last: {
					at,
					durationMs: 10_776,
					method: "POST",
					requestBytes: 120,
					requestId: "req-1",
					responseBytes: 80,
					status: 200,
					url: EXTRACT,
				},
			}),
			at,
		)
		expect(field(line, "status")).toBe("ok")
		expect(field(line, "path")).toBe("/v1/projects/p1/extract")
		expect(field(line, "http")).toBe("200")
		expect(field(line, "last_ms")).toBe("10776")
		expect(field(line, "idle_ms")).toBe("0")
		expect(field(line, "req_id")).toBe("req-1")
	})

	it("marks stall only after a completed call sits idle", () => {
		const at = 1_000
		const line = formatProgressLine(
			snap({
				last: {
					at,
					durationMs: 10,
					method: "GET",
					requestBytes: 40,
					requestId: "",
					responseBytes: 40,
					status: 200,
					url: "http://127.0.0.1/v1/tables",
				},
			}),
			at + 15_000,
		)
		expect(field(line, "status")).toBe("stall")
		expect(field(line, "path")).toBe("/v1/tables")
	})

	it("keeps TSV column count and JSONL http=null while in flight", () => {
		const live = snap({ inflight: { at: 0, method: "POST", url: EXTRACT } })
		const tsv = formatProgressTsv(live, 1_000)
		expect(tsv.split("\t")).toHaveLength(PROGRESS_TSV_HEADER.split("\t").length)
		expect(tsv.split("\t")[1]).toBe("in_flight")
		const json = JSON.parse(formatProgressJsonl(live, 1_000)) as { http: unknown; status: string; path: string }
		expect(json.status).toBe("in_flight")
		expect(json.http).toBeNull()
		expect(json.path).toBe("/v1/projects/p1/extract")
	})

	it("changes the event key when a request goes in flight or returns", () => {
		const idle = snap({
			last: {
				at: 1,
				durationMs: 5,
				method: "GET",
				requestBytes: 1,
				requestId: "",
				responseBytes: 1,
				status: 200,
				url: "http://127.0.0.1/v1/tables",
			},
		})
		const flying = snap({
			inflight: { at: 10, method: "POST", url: EXTRACT },
			last: idle.last,
		})
		const done = snap({
			last: {
				at: 20,
				durationMs: 10,
				method: "POST",
				requestBytes: 1,
				requestId: "",
				responseBytes: 1,
				status: 200,
				url: EXTRACT,
			},
		})
		expect(progressEventKey(flying)).not.toBe(progressEventKey(idle))
		expect(progressEventKey(done)).not.toBe(progressEventKey(flying))
	})
})

describe("progress pump heartbeat", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("rewrites the in-flight row every 5s", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"))
		const writes: Array<{ idle: string | undefined; path: string | undefined }> = []
		const pump = createProgressPump(Date.now(), (current, now) => {
			const line = formatProgressLine(current, now)
			writes.push({ idle: field(line, "idle_ms"), path: field(line, "path") })
		})
		pump.emit(
			snap({
				elapsedMs: 0,
				inflight: { at: Date.now(), method: "POST", url: EXTRACT },
			}),
		)
		expect(writes[0]?.path).toBe("/v1/projects/p1/extract")
		vi.advanceTimersByTime(HEARTBEAT_MS)
		expect(writes.length).toBeGreaterThanOrEqual(2)
		expect(writes.at(-1)?.path).toBe("/v1/projects/p1/extract")
		expect(Number(writes.at(-1)?.idle)).toBeGreaterThanOrEqual(HEARTBEAT_MS)
		pump.stop()
	})
})

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

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

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
	close: () => Promise<void>
	url: string
}> {
	const server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address() as AddressInfo
	const handle = {
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
	closers.push(handle.close)
	return handle
}

describe("Client HTTP hooks", () => {
	it("fires start before fetch returns and end after", async () => {
		const events: string[] = []
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const server = await listen((_req, res) => {
			void gate.then(() => send(res, 200, { ok: true }))
		})
		const client = new Client(
			server.url,
			{},
			1,
			(exchange) => {
				events.push(`complete:${exchange.status}`)
			},
			undefined,
			{
				end: (probe) => {
					events.push(`end:${new URL(probe.url).pathname}`)
				},
				start: (probe) => {
					events.push(`start:${probe.method}:${new URL(probe.url).pathname}`)
				},
			},
		)
		const pending = client.request("POST", "/v1/projects/p1/extract")
		await vi.waitFor(() => {
			expect(events[0]).toBe("start:POST:/v1/projects/p1/extract")
		})
		expect(events).toEqual(["start:POST:/v1/projects/p1/extract"])
		release()
		const exchange = await pending
		expect(exchange.status).toBe(200)
		expect(events).toEqual(["start:POST:/v1/projects/p1/extract", "end:/v1/projects/p1/extract", "complete:200"])
		expect(exchange.durationMs).toBeGreaterThanOrEqual(0)
	})
})

const ITEM = {
	properties: { id: { type: "string" }, name: { type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const SPEC = {
	info: { title: "progress", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/openapi/spec": {
			get: { operationId: "spec.read", responses: { "200": { description: "ok" } } },
		},
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
				},
				"x-entity": { action: "list", identity: "id", name: "widget" },
			},
			post: {
				operationId: "widget.create",
				requestBody: {
					content: {
						"application/json": {
							schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
						},
					},
					required: true,
				},
				responses: { "201": { content: { "application/json": { schema: ITEM } }, description: "created" } },
				"x-entity": { action: "create", identity: "id", name: "widget" },
			},
		},
		"/v1/widgets/{id}": {
			get: {
				operationId: "widget.read",
				responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
				"x-entity": { action: "read", identity: "id", name: "widget" },
			},
			patch: {
				operationId: "widget.update",
				requestBody: {
					content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
				},
				responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
				"x-entity": { action: "update", identity: "id", name: "widget" },
			},
			delete: {
				operationId: "widget.delete",
				responses: { "204": { description: "gone" } },
				"x-entity": { action: "delete", identity: "id", name: "widget" },
			},
		},
		"/v1/widgets/{id}/extract": {
			post: {
				operationId: "widget.extract",
				responses: { "200": { content: { "application/json": { schema: ITEM } }, description: "ok" } },
				"x-effects": [{ entity: "widget", op: "update" }],
				"x-entity": { action: "action", identity: "id", name: "widget" },
			},
		},
	},
} as OpenApiDocument

describe("run() in-flight progress", () => {
	it("publishes a start event before the completed line for a slow POST", { timeout: 30_000 }, async () => {
		const rows = new Map<string, { id: string; name: string }>()
		let seq = 0
		const events: ProgressSnapshot[] = []
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				const method = (req.method ?? "GET").toUpperCase()
				if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, SPEC)
				if (url.pathname === "/v1/widgets" && method === "GET") return send(res, 200, { items: [...rows.values()] })
				if (url.pathname === "/v1/widgets" && method === "POST") {
					await new Promise((resolve) => setTimeout(resolve, 80))
					seq += 1
					const row = { id: `w_${seq}`, name: "n" }
					rows.set(row.id, row)
					return send(res, 201, row)
				}
				const item = /^\/v1\/widgets\/([^/]+)$/.exec(url.pathname)
				if (item !== null && method === "GET") {
					const row = rows.get(item[1] ?? "")
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				if (item !== null && method === "PATCH") {
					const row = rows.get(item[1] ?? "")
					if (row === undefined) return send(res, 404)
					return send(res, 200, row)
				}
				if (item !== null && method === "DELETE") {
					rows.delete(item[1] ?? "")
					return send(res, 204)
				}
				const extract = /^\/v1\/widgets\/([^/]+)\/extract$/.exec(url.pathname)
				if (extract !== null && method === "POST") {
					await new Promise((resolve) => setTimeout(resolve, 80))
					const row = rows.get(extract[1] ?? "")
					return row === undefined ? send(res, 404) : send(res, 200, row)
				}
				return send(res, 404)
			})()
		})

		const result = await run({
			baseUrl: server.url,
			keepFixtures: true,
			onProgress: (current) => {
				events.push({
					...current,
					...(current.inflight === undefined ? {} : { inflight: { ...current.inflight } }),
					...(current.last === undefined ? {} : { last: { ...current.last } }),
				})
			},
			only: ["widget"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})

		const firstCreate = events.findIndex(
			(event) => event.inflight?.url.endsWith("/v1/widgets") && event.inflight.method === "POST",
		)
		expect(firstCreate).toBeGreaterThanOrEqual(0)
		expect(
			events
				.slice(0, firstCreate)
				.some((event) => event.last?.url.endsWith("/v1/widgets") && event.last.method === "POST"),
		).toBe(false)
		const start = events[firstCreate] as ProgressSnapshot
		const startLine = formatProgressLine(start, (start.inflight?.at ?? 0) + 40)
		expect(field(startLine, "status")).toBe("in_flight")
		expect(field(startLine, "path")).toBe("/v1/widgets")
		expect(field(startLine, "http")).toBe("-")
		expect(field(startLine, "last_ms")).toBe("-")
		const later = formatProgressLine(start, (start.inflight?.at ?? 0) + 4_000)
		expect(field(later, "path")).toBe("/v1/widgets")
		expect(Number(field(later, "idle_ms"))).toBeGreaterThan(Number(field(startLine, "idle_ms") ?? "0"))

		const finished = events.find(
			(event) =>
				event.last?.url.endsWith("/v1/widgets") &&
				event.last.method === "POST" &&
				event.last.status === 201 &&
				event.inflight === undefined,
		)
		expect(finished?.last?.durationMs).toBeGreaterThanOrEqual(80)
		expect(result.entitiesTested).toEqual(["widget"])
	})
})
