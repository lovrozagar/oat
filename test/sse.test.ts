import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { inspectStreamAsync, resolveAsyncId } from "../src/runtime/async.ts"
import { CHECKS } from "../src/runtime/checks.ts"
import { Client } from "../src/runtime/client.ts"
import { FindingCollector } from "../src/runtime/finding.ts"
import { run } from "../src/runtime/run.ts"
import { parseSse, sseEvents } from "../src/runtime/sse.ts"
import { SchemaValidator } from "../src/runtime/validate.ts"
import { documentsEventStream } from "../src/spec/collection.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument, OperationObject } from "../src/spec/types.ts"

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

function sendSse(res: ServerResponse, body: string): void {
	res.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" })
	res.end(body)
}

const COMPLETE_STREAM = 'event: batch\ndata: {"batch_id":"b_1"}\n\nevent: complete\ndata: {"status":"complete"}\n\n'
const BATCH_ONLY_STREAM = 'event: batch\ndata: {"batch_id":"b_1"}\n\n'

function itemSchema(): Record<string, unknown> {
	return {
		properties: { id: { type: "string" }, name: { type: "string" } },
		required: ["id", "name"],
		type: "object",
	}
}

function streamSpec(opts: { async: boolean }): OpenApiDocument {
	const stream: Record<string, unknown> = {
		operationId: "extract.stream",
		requestBody: {
			content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
		},
		responses: {
			"200": {
				content: { "text/event-stream": { schema: { type: "string" } } },
				description: "stream",
			},
		},
		"x-effects": [{ entity: "batch", op: "update" }],
		"x-entity": { action: "action", identity: "id", name: "batch" },
	}
	if (opts.async) {
		stream["x-async"] = {
			idFrom: "$.batch_id",
			poll: "GET /v1/batches/{batch_id}",
			pollIntervalMs: 1,
			successWhen: "status.eq.complete",
			timeoutMs: 1_000,
			until: "status.eq.complete",
		}
	}
	return {
		info: { title: "sse", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/batches": {
				get: {
					operationId: "batch.list",
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: {
										properties: { batches: { items: itemSchema(), type: "array" } },
										required: ["batches"],
										type: "object",
									},
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "batch" },
				},
				post: {
					operationId: "batch.create",
					requestBody: {
						content: {
							"application/json": {
								schema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" },
							},
						},
						required: true,
					},
					responses: {
						"201": { content: { "application/json": { schema: itemSchema() } }, description: "created" },
					},
					"x-entity": { action: "create", identity: "id", name: "batch" },
				},
			},
			"/v1/batches/{batch_id}": {
				get: {
					operationId: "batch.read",
					parameters: [{ in: "path", name: "batch_id", required: true, schema: { type: "string" } }],
					responses: {
						"200": { content: { "application/json": { schema: itemSchema() } }, description: "ok" },
					},
					"x-entity": { action: "read", identity: "id", name: "batch" },
				},
			},
			"/v1/extract/stream": { post: stream },
		},
	} as OpenApiDocument
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
	return {
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			}),
		url: `http://127.0.0.1:${addr.port}`,
	}
}

async function serve(
	spec: OpenApiDocument,
	streamBody: string,
): Promise<{
	polls: string[]
	url: string
}> {
	const rows = new Map<string, { id: string; name: string }>()
	const polls: string[] = []
	let next = 1
	const server = await listen((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const method = (req.method ?? "GET").toUpperCase()
		if (url.pathname === "/v1/openapi/spec" && method === "GET") return send(res, 200, spec)
		if (url.pathname === "/v1/batches" && method === "GET") {
			return send(res, 200, { batches: [...rows.values()] })
		}
		if (url.pathname === "/v1/batches" && method === "POST") {
			const id = `row_${next++}`
			const row = { id, name: "seed" }
			rows.set(id, row)
			return send(res, 201, row)
		}
		if (url.pathname === "/v1/extract/stream" && method === "POST") {
			return sendSse(res, streamBody)
		}
		const item = /^\/v1\/batches\/([^/]+)$/.exec(url.pathname)
		if (item !== null && method === "GET") {
			polls.push(item[1] ?? "")
			const existing = rows.get(item[1] ?? "")
			if (existing !== undefined) return send(res, 200, existing)
			return send(res, 200, { batch_id: item[1], id: item[1], name: "job", status: "complete" })
		}
		return send(res, 404)
	})
	closers.push(server.close)
	return { polls, url: server.url }
}

const ASYNC = {
	idFrom: "$.batch_id",
	poll: "GET /v1/batches/{batch_id}",
	pollIntervalMs: 1,
	successWhen: "status.eq.complete",
	timeoutMs: 1_000,
	until: "status.eq.complete",
} as const

describe("SSE frames", () => {
	it("parses event/data frames and JSON data", () => {
		const events = parseSse(COMPLETE_STREAM)
		expect(events.map((e) => e.event)).toEqual(["batch", "complete"])
		expect(events[0]?.data).toEqual({ batch_id: "b_1" })
		expect(events[1]?.data).toEqual({ status: "complete" })
	})

	it("parses comments, CRLF, default event, arrays, and broken JSON", () => {
		const text = [
			": keep-alive",
			"data: hello",
			"",
			"event: items",
			"data: [1, 2]",
			"",
			"data: {not json",
			"",
			"event: batch\r",
			'data: {"batch_id":"crlf"}\r',
			"\r",
		].join("\n")
		const events = parseSse(text)
		expect(events).toEqual([
			{ data: "hello", event: "message", raw: "hello" },
			{ data: [1, 2], event: "items", raw: "[1, 2]" },
			{ data: "{not json", event: "message", raw: "{not json" },
			{ data: { batch_id: "crlf" }, event: "batch", raw: '{"batch_id":"crlf"}' },
		])
	})

	it("joins multiline data and skips empty frames", () => {
		const events = parseSse('event: note\ndata: {"a":1}\ndata: extra\n\nevent: unused\n\n')
		expect(events).toHaveLength(1)
		expect(events[0]).toEqual({ data: '{"a":1}\nextra', event: "note", raw: '{"a":1}\nextra' })
	})

	it("sseEvents only accepts a string that looks like SSE", () => {
		expect(sseEvents({ batch_id: "x" })).toBeNull()
		expect(sseEvents("not a stream")).toBeNull()
		expect(sseEvents("data: x\n\n")).toEqual([{ data: "x", event: "message", raw: "x" }])
	})

	it("resolves idFrom against event JSON, not the raw string", () => {
		expect(resolveAsyncId(COMPLETE_STREAM, "$.batch_id")).toBe("b_1")
		expect(resolveAsyncId({ batch_id: "from-object" }, "$.batch_id")).toBe("from-object")
		expect(resolveAsyncId(BATCH_ONLY_STREAM, "$.missing")).toBeUndefined()
		const viewed = inspectStreamAsync(COMPLETE_STREAM, ASYNC)
		expect(viewed?.id).toBe("b_1")
		expect(viewed?.terminal).toEqual({ status: "complete" })
	})

	it("takes the first idFrom hit and treats named error or until as terminal", () => {
		const twoIds = 'event: batch\ndata: {"batch_id":"first"}\n\nevent: batch\ndata: {"batch_id":"second"}\n\n'
		expect(resolveAsyncId(twoIds, "$.batch_id")).toBe("first")

		const errorFrame = 'event: error\ndata: {"status":"failed","batch_id":"b_1"}\n\n'
		expect(inspectStreamAsync(errorFrame, ASYNC)?.terminal).toEqual({ batch_id: "b_1", status: "failed" })

		const untilOnly = 'event: progress\ndata: {"batch_id":"b_1","status":"complete"}\n\n'
		expect(inspectStreamAsync(untilOnly, ASYNC)?.terminal).toEqual({ batch_id: "b_1", status: "complete" })
		expect(inspectStreamAsync("hello", ASYNC)).toBeNull()
	})
})

describe("documentsEventStream", () => {
	const op = (responses: OperationObject["responses"]): OperationObject => ({
		operationId: "op",
		responses,
	})

	it("is true for any success response that lists text/event-stream", () => {
		expect(documentsEventStream(op({ "200": { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(true)
		expect(documentsEventStream(op({ "201": { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(true)
		expect(documentsEventStream(op({ "202": { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(true)
		expect(documentsEventStream(op({ "2XX": { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(true)
		expect(documentsEventStream(op({ default: { content: { "text/event-stream": {} }, description: "ok" } }))).toBe(
			true,
		)
	})

	it("is false when only an error response or JSON success lists the type", () => {
		expect(documentsEventStream(op({ "400": { content: { "text/event-stream": {} }, description: "no" } }))).toBe(false)
		expect(documentsEventStream(op({ "200": { content: { "application/json": {} }, description: "ok" } }))).toBe(false)
		expect(streamSpec({ async: false }).paths?.["/v1/extract/stream"]).toBeDefined()
		const model = buildModel(dereference(streamSpec({ async: true })).doc)
		expect(model.byOperationId.get("extract.stream")?.eventStream).toBe(true)
		expect(model.byOperationId.get("batch.create")?.eventStream).toBe(false)
	})
})

describe("stream from text/event-stream", () => {
	it("consumes a documented stream without x-async and does not poll or look for batch_id", async () => {
		const spec = streamSpec({ async: false })
		const server = await serve(spec, COMPLETE_STREAM)
		const result = await run({
			baseUrl: server.url,
			only: ["batch"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const streamPosts = result.client.transcript.filter((e) => new URL(e.url).pathname === "/v1/extract/stream")
		expect(streamPosts.length).toBeGreaterThan(0)
		expect(streamPosts.every((e) => e.status === 200)).toBe(true)
		expect(server.polls).not.toContain("b_1")
		expect(result.findings.filter((f) => f.check.startsWith("async."))).toEqual([])
		expect(result.checksRun).not.toContain("async.receipt-identifies-the-job")
		expect(result.checksRun).not.toContain("async.reaches-terminal-state")
	})

	it("reads batch_id from event: batch and does not poll after event: complete", async () => {
		const spec = streamSpec({ async: true })
		const server = await serve(spec, COMPLETE_STREAM)
		const result = await run({
			baseUrl: server.url,
			only: ["batch"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(result.checksRun).toContain("async.reaches-terminal-state")
		expect(result.checksRun).toContain("async.receipt-identifies-the-job")
		expect(result.findings.filter((f) => f.check.startsWith("async."))).toEqual([])
		expect(server.polls).not.toContain("b_1")
		const stream = result.client.transcript.find((e) => new URL(e.url).pathname === "/v1/extract/stream")
		expect(stream?.status).toBe(200)
		expect(typeof stream?.responseBody).toBe("string")
	})

	it("polls with the stream batch_id when the stream never emits complete", async () => {
		const spec = streamSpec({ async: true })
		const server = await serve(spec, BATCH_ONLY_STREAM)
		const result = await run({
			baseUrl: server.url,
			only: ["batch"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(server.polls).toContain("b_1")
		expect(result.findings.filter((f) => f.check === "async.reaches-terminal-state")).toEqual([])
		expect(result.findings.filter((f) => f.check === "async.receipt-identifies-the-job")).toEqual([])
	})

	it("does not treat a raw SSE body as a JSON schema defect", async () => {
		const spec = {
			info: { title: "sse-schema", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/batches": {
					get: {
						operationId: "batch.list",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "list", identity: "id", name: "batch" },
					},
					post: {
						operationId: "batch.create",
						requestBody: {
							content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
						},
						responses: {
							"200": {
								content: {
									"application/json": { schema: itemSchema() },
									"text/event-stream": { schema: { type: "string" } },
								},
								description: "ok",
							},
						},
						"x-entity": { action: "create", identity: "id", name: "batch" },
					},
				},
			},
		} as OpenApiDocument
		const model = buildModel(dereference(spec).doc)
		const createOp = model.byOperationId.get("batch.create")
		const listOp = model.byOperationId.get("batch.list")
		expect(createOp?.eventStream).toBe(true)
		expect(createOp).toBeDefined()
		expect(listOp).toBeDefined()

		const client = new Client("http://127.0.0.1")
		client.transcript.push({
			at: Date.now(),
			durationMs: 1,
			method: "POST",
			requestBody: { name: "x" },
			requestBytes: 0,
			requestHeaders: {},
			requestId: "",
			responseBody: COMPLETE_STREAM,
			responseBytes: COMPLETE_STREAM.length,
			responseHeaders: { "content-type": "text/event-stream" },
			seq: 1,
			status: 200,
			url: "http://127.0.0.1/v1/batches",
		})
		const findings = new FindingCollector()
		const check = CHECKS.find((c) => c.id === "schema.success-response-matches-document")
		expect(check).toBeDefined()
		await check?.run({
			actors: [],
			altAuth: undefined,
			altScope: undefined,
			asyncOps: [],
			auth: () => ({}),
			client,
			collectionKey: null,
			createOp,
			deleteOp: undefined,
			effectOps: [],
			entityName: "batch",
			findings,
			hooks: {},
			identity: "id",
			invite: null,
			listOp: listOp!,
			model,
			outOfBand: { attempts: 6, initialMs: 200, maxMs: 3000 },
			query: null,
			readOp: undefined,
			records: [],
			scope: {},
			seed: 1,
			softDelete: null,
			updateOp: undefined,
			uploads: { seed: 1 },
			validator: new SchemaValidator(),
			waitOps: [],
		})
		expect(findings.findings.filter((f) => f.check === "schema.success-response-matches-document")).toEqual([])
	})

	it("skips the JSON schema check when only the live Content-Type is event-stream", async () => {
		const spec = {
			info: { title: "sse-live", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/batches": {
					get: {
						operationId: "batch.list",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "list", identity: "id", name: "batch" },
					},
					post: {
						operationId: "batch.create",
						requestBody: {
							content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
						},
						responses: {
							"200": { content: { "application/json": { schema: itemSchema() } }, description: "ok" },
						},
						"x-entity": { action: "create", identity: "id", name: "batch" },
					},
				},
			},
		} as OpenApiDocument
		const model = buildModel(dereference(spec).doc)
		const createOp = model.byOperationId.get("batch.create")
		const listOp = model.byOperationId.get("batch.list")
		expect(createOp?.eventStream).toBe(false)
		const client = new Client("http://127.0.0.1")
		client.transcript.push({
			at: Date.now(),
			durationMs: 1,
			method: "POST",
			requestBody: { name: "x" },
			requestBytes: 0,
			requestHeaders: {},
			requestId: "",
			responseBody: COMPLETE_STREAM,
			responseBytes: COMPLETE_STREAM.length,
			responseHeaders: { "content-type": "text/event-stream" },
			seq: 1,
			status: 200,
			url: "http://127.0.0.1/v1/batches",
		})
		const findings = new FindingCollector()
		const check = CHECKS.find((c) => c.id === "schema.success-response-matches-document")
		await check?.run({
			actors: [],
			altAuth: undefined,
			altScope: undefined,
			asyncOps: [],
			auth: () => ({}),
			client,
			collectionKey: null,
			createOp,
			deleteOp: undefined,
			effectOps: [],
			entityName: "batch",
			findings,
			hooks: {},
			identity: "id",
			invite: null,
			listOp: listOp!,
			model,
			outOfBand: { attempts: 6, initialMs: 200, maxMs: 3000 },
			query: null,
			readOp: undefined,
			records: [],
			scope: {},
			seed: 1,
			softDelete: null,
			updateOp: undefined,
			uploads: { seed: 1 },
			validator: new SchemaValidator(),
			waitOps: [],
		})
		expect(findings.findings.filter((f) => f.check === "schema.success-response-matches-document")).toEqual([])
	})

	it("does not JSON.parse an event-stream body even when the bytes are valid JSON", async () => {
		const server = await listen((req, res) => {
			if ((req.url ?? "") === "/stream") {
				res.writeHead(200, { "content-type": "text/event-stream" })
				res.end('{"ok":true}')
				return
			}
			send(res, 404)
		})
		closers.push(server.close)
		const exchange = await new Client(server.url).request("GET", "/stream")
		expect(exchange.status).toBe(200)
		expect(typeof exchange.responseBody).toBe("string")
		expect(exchange.responseBody).toBe('{"ok":true}')
	})

	it("treats event: error as terminal and does not poll", async () => {
		const spec = streamSpec({ async: true })
		const server = await serve(
			spec,
			'event: batch\ndata: {"batch_id":"b_1"}\n\nevent: error\ndata: {"status":"failed"}\n\n',
		)
		const result = await run({
			baseUrl: server.url,
			only: ["batch"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(server.polls).not.toContain("b_1")
		expect(result.findings.filter((f) => f.check === "async.receipt-identifies-the-job")).toEqual([])
		const terminal = result.findings.find((f) => f.check === "async.reaches-terminal-state")
		expect(terminal?.verdict).toBe("COVERAGE_GAP")
	})

	it("treats data.status matching until as terminal without a named complete frame", async () => {
		const spec = streamSpec({ async: true })
		const server = await serve(spec, 'event: progress\ndata: {"batch_id":"b_1","status":"complete"}\n\n')
		const result = await run({
			baseUrl: server.url,
			only: ["batch"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(server.polls).not.toContain("b_1")
		expect(result.findings.filter((f) => f.check.startsWith("async."))).toEqual([])
	})

	it("reports disappeared and a missing id when the stream has neither complete nor batch_id", async () => {
		const spec = streamSpec({ async: true })
		const server = await serve(spec, 'event: progress\ndata: {"ok":true}\n\n')
		const result = await run({
			baseUrl: server.url,
			only: ["batch"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(server.polls).not.toContain("b_1")
		expect(result.findings.some((f) => f.check === "async.reaches-terminal-state" && f.verdict === "BACKEND_BUG")).toBe(
			true,
		)
		expect(
			result.findings.some((f) => f.check === "async.receipt-identifies-the-job" && f.verdict === "SPEC_BUG"),
		).toBe(true)
	})
})
