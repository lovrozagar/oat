import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { runCheck } from "../../src/runtime/checks/core/run.ts"
import { CHECKS } from "../../src/runtime/checks/registry.ts"
import { Client } from "../../src/client/client.ts"
import { type Finding, FindingCollector } from "../../src/runtime/finding.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { RunResult } from "../../src/runtime/run/index.ts"
import { SchemaValidator } from "../../src/runtime/validate.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"
import { BATCH_ONLY_STREAM, COMPLETE_STREAM, itemSchema, streamSpec } from "../support/sse-fixtures.ts"
import { Redactor } from "../../src/security/redact.ts"

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

/** The batch backend's state: the spec it serves, the stream it answers, its rows and the polls it saw. */
interface BatchWorld {
	spec: OpenApiDocument
	streamBody: string
	rows: Map<string, { id: string; name: string }>
	polls: string[]
	next: number
}

function createBatch(world: BatchWorld, res: ServerResponse): void {
	const id = `row_${world.next++}`
	const row = { id, name: "seed" }
	world.rows.set(id, row)
	send(res, 201, row)
}

function readBatch(world: BatchWorld, id: string, res: ServerResponse): void {
	world.polls.push(id)
	const existing = world.rows.get(id)
	if (existing !== undefined) return send(res, 200, existing)
	send(res, 200, { batch_id: id, id, name: "job", status: "complete" })
}

function answerBatch(world: BatchWorld, req: IncomingMessage, res: ServerResponse): void {
	const url = new URL(req.url ?? "/", "http://127.0.0.1")
	const route = `${(req.method ?? "GET").toUpperCase()} ${url.pathname}`
	if (route === "GET /v1/openapi/spec") return send(res, 200, world.spec)
	if (route === "GET /v1/batches") return send(res, 200, { batches: [...world.rows.values()] })
	if (route === "POST /v1/batches") return createBatch(world, res)
	if (route === "POST /v1/extract/stream") return sendSse(res, world.streamBody)
	const item = /^GET \/v1\/batches\/([^/]+)$/.exec(route)
	if (item !== null) return readBatch(world, item[1] ?? "", res)
	send(res, 404)
}

async function serve(
	spec: OpenApiDocument,
	streamBody: string,
): Promise<{
	polls: string[]
	url: string
}> {
	const world: BatchWorld = { next: 1, polls: [], rows: new Map(), spec, streamBody }
	const server = await listen((req, res) => answerBatch(world, req, res))
	closers.push(server.close)
	return { polls: world.polls, url: server.url }
}

/** Serves the batch API with `streamBody` as the stream and runs oat over the batch entity. */
async function runStream(async: boolean, streamBody: string): Promise<{ polls: string[]; result: RunResult }> {
	const server = await serve(streamSpec({ async }), streamBody)
	const result = await run({
		baseUrl: server.url,
		only: ["batch"],
		principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
		seed: 1,
		spec: `${server.url}/v1/openapi/spec`,
	})
	return { polls: server.polls, result }
}

async function consumesWithoutAsync(): Promise<void> {
	const { polls, result } = await runStream(false, COMPLETE_STREAM)
	const streamPosts = result.client.transcript.filter((e) => new URL(e.url).pathname === "/v1/extract/stream")
	expect(streamPosts.length).toBeGreaterThan(0)
	expect(streamPosts.every((e) => e.status === 200)).toBe(true)
	expect(polls).not.toContain("b_1")
	expect(result.findings.filter((f) => f.check.startsWith("async."))).toEqual([])
	expect(result.checksRun).not.toContain("async.receipt-identifies-the-job")
	expect(result.checksRun).not.toContain("async.reaches-terminal-state")
}

async function readsBatchIdThenStops(): Promise<void> {
	const { polls, result } = await runStream(true, COMPLETE_STREAM)
	expect(result.checksRun).toContain("async.reaches-terminal-state")
	expect(result.checksRun).toContain("async.receipt-identifies-the-job")
	expect(result.findings.filter((f) => f.check.startsWith("async."))).toEqual([])
	expect(polls).not.toContain("b_1")
	const stream = result.client.transcript.find((e) => new URL(e.url).pathname === "/v1/extract/stream")
	expect(stream?.status).toBe(200)
	expect(stream?.responseBody).toEqual([
		{ data: { batch_id: "b_1" }, event: "batch" },
		{ data: { status: "complete" }, event: "complete" },
	])
}

async function pollsWithoutComplete(): Promise<void> {
	const { polls, result } = await runStream(true, BATCH_ONLY_STREAM)
	expect(polls).toContain("b_1")
	expect(result.findings.filter((f) => f.check === "async.reaches-terminal-state")).toEqual([])
	expect(result.findings.filter((f) => f.check === "async.receipt-identifies-the-job")).toEqual([])
}

/** A batch list and create whose create documents `success` as its 200 content. */
function schemaSpec(title: string, success: Record<string, unknown>): OpenApiDocument {
	return {
		info: { title, version: "1" },
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
					responses: { "200": { content: success, description: "ok" } },
					"x-entity": { action: "create", identity: "id", name: "batch" },
				},
			},
		},
	} as OpenApiDocument
}

/** A client whose transcript holds one create answered with an event-stream body. */
function streamedCreateClient(): Client {
	const client = new Client({ baseUrl: "http://127.0.0.1", redactor: new Redactor() })
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
	return client
}

const SCHEMA_CHECK = "schema.success-response-matches-document"

/** Runs the success-schema check over a streamed create against `model`; its findings and whether it exists. */
async function schemaCheckFindings(model: ReturnType<typeof buildModel>): Promise<{
	found: boolean
	findings: Finding[]
}> {
	const findings = new FindingCollector()
	const check = CHECKS.find((c) => c.id === SCHEMA_CHECK)
	if (check !== undefined)
		await runCheck(
			check,
			checkContext({
				actors: [],
				altAuth: undefined,
				altScope: undefined,
				asyncOps: [],
				auth: () => ({}),
				client: streamedCreateClient(),
				collectionKey: null,
				createOp: model.byOperationId.get("batch.create"),
				deleteOp: undefined,
				effectOps: [],
				entityName: "batch",
				findings,
				hooks: {},
				identity: "id",
				invite: null,
				listOp: model.byOperationId.get("batch.list")!,
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
			}),
		)
	return { findings: findings.findings.filter((f) => f.check === SCHEMA_CHECK), found: check !== undefined }
}

async function rawSseIsNoSchemaDefect(): Promise<void> {
	const spec = schemaSpec("sse-schema", {
		"application/json": { schema: itemSchema() },
		"text/event-stream": { schema: { type: "string" } },
	})
	const model = buildModel(dereference(spec).doc)
	const createOp = model.byOperationId.get("batch.create")
	expect(createOp?.eventStream).toBe(true)
	expect(createOp).toBeDefined()
	expect(model.byOperationId.get("batch.list")).toBeDefined()
	const { findings, found } = await schemaCheckFindings(model)
	expect(found).toBe(true)
	expect(findings).toEqual([])
}

async function liveEventStreamSkipsSchema(): Promise<void> {
	const spec = schemaSpec("sse-live", { "application/json": { schema: itemSchema() } })
	const model = buildModel(dereference(spec).doc)
	expect(model.byOperationId.get("batch.create")?.eventStream).toBe(false)
	const { findings } = await schemaCheckFindings(model)
	expect(findings).toEqual([])
}

async function keepsJsonLikeStreamText(): Promise<void> {
	const server = await listen((req, res) => {
		if ((req.url ?? "") === "/stream") {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.end('{"ok":true}')
			return
		}
		send(res, 404)
	})
	closers.push(server.close)
	const exchange = await new Client({ baseUrl: server.url, redactor: new Redactor() }).request("GET", "/stream")
	expect(exchange.status).toBe(200)
	expect(typeof exchange.responseBody).toBe("string")
	expect(exchange.responseBody).toBe('{"ok":true}')
}

async function errorEventIsTerminal(): Promise<void> {
	const { polls, result } = await runStream(
		true,
		'event: batch\ndata: {"batch_id":"b_1"}\n\nevent: error\ndata: {"status":"failed"}\n\n',
	)
	expect(polls).not.toContain("b_1")
	expect(result.findings.filter((f) => f.check === "async.receipt-identifies-the-job")).toEqual([])
	const terminal = result.findings.find((f) => f.check === "async.reaches-terminal-state")
	expect(terminal?.verdict).toBe("COVERAGE_GAP")
}

async function untilStatusIsTerminal(): Promise<void> {
	const { polls, result } = await runStream(true, 'event: progress\ndata: {"batch_id":"b_1","status":"complete"}\n\n')
	expect(polls).not.toContain("b_1")
	expect(result.findings.filter((f) => f.check.startsWith("async."))).toEqual([])
}

async function reportsDisappearedAndMissingId(): Promise<void> {
	const { polls, result } = await runStream(true, 'event: progress\ndata: {"ok":true}\n\n')
	expect(polls).not.toContain("b_1")
	expect(result.findings.some((f) => f.check === "async.reaches-terminal-state" && f.verdict === "BACKEND_BUG")).toBe(
		true,
	)
	expect(result.findings.some((f) => f.check === "async.receipt-identifies-the-job" && f.verdict === "SPEC_BUG")).toBe(
		true,
	)
}

describe("stream from text/event-stream", () => {
	it("consumes a documented stream without x-async and does not poll or look for batch_id", consumesWithoutAsync)
	it("reads batch_id from event: batch and does not poll after event: complete", readsBatchIdThenStops)
	it("polls with the stream batch_id when the stream never emits complete", pollsWithoutComplete)
	it("does not treat a raw SSE body as a JSON schema defect", rawSseIsNoSchemaDefect)
	it("skips the JSON schema check when only the live Content-Type is event-stream", liveEventStreamSkipsSchema)
	it("does not JSON.parse an event-stream body even when the bytes are valid JSON", keepsJsonLikeStreamText)
	it("treats event: error as terminal and does not poll", errorEventIsTerminal)
	it("treats data.status matching until as terminal without a named complete frame", untilStatusIsTerminal)
	it(
		"reports disappeared and a missing id when the stream has neither complete nor batch_id",
		reportsDisappearedAndMissingId,
	)
})
