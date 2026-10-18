import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import { driveWait, pointerIsOccupied, readPointer } from "../../src/runtime/wait.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { readWait } from "../../src/spec/extensions/async.ts"
import { run } from "../../src/runtime/run/index.ts"
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

describe("readPointer / occupancy", () => {
	it("reads dot paths, JSON pointers, and escapes", () => {
		const body = { items: [{ id: "a" }], "a/b": { "~": 1 } }
		expect(readPointer(body, "$.items.0.id")).toBe("a")
		expect(readPointer(body, "/items/0/id")).toBe("a")
		expect(readPointer(body, "/")).toEqual(body)
		expect(readPointer(body, "/a~1b/~0")).toBe(1)
		expect(readPointer(body, "$.missing")).toBeUndefined()
		expect(readPointer(null, "$.a")).toBeUndefined()
		expect(readPointer([{ id: 1 }], "foo")).toBeUndefined()
		expect(readPointer("x", "")).toBe("x")
		expect(readPointer([{ id: 1 }], "/0/id")).toBe(1)
		expect(readPointer([{ id: 1 }], "/nope")).toBeUndefined()
		expect(readPointer({ items: "x" }, "/items/0")).toBeUndefined()
		expect(readPointer({ items: "x" }, "$.items.0")).toBeUndefined()
	})

	it("treats empty values as unoccupied", () => {
		expect(pointerIsOccupied(undefined)).toBe(false)
		expect(pointerIsOccupied(null)).toBe(false)
		expect(pointerIsOccupied("")).toBe(false)
		expect(pointerIsOccupied([])).toBe(false)
		expect(pointerIsOccupied(0)).toBe(true)
		expect(pointerIsOccupied(false)).toBe(true)
		expect(pointerIsOccupied({ a: 1 })).toBe(true)
	})
})

describe("readWait", () => {
	it("defaults timeout to 30s and ignores a tag without operationId", () => {
		expect(readWait({ responses: {} })).toBeNull()
		expect(readWait({ responses: {}, "x-wait": { operationId: "" } } as never)).toBeNull()
		expect(readWait({ responses: {}, "x-wait": { operationId: "inbox.list" } } as never)).toEqual({
			operationId: "inbox.list",
			pollIntervalMs: 1000,
			timeoutMs: 30_000,
		})
		expect(
			readWait({
				responses: {},
				"x-wait": { operationId: "inbox.list", pollIntervalMs: 5, timeoutMs: 10, until: "$.items.0" },
			} as never),
		).toMatchObject({ pollIntervalMs: 5, timeoutMs: 10, until: "$.items.0" })
	})
})

const WAIT_SPEC = {
	info: { title: "wait", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/inbox": {
			get: { operationId: "inbox.list", responses: { "200": { description: "ok" } } },
		},
		"/inbox/{missing}": {
			get: {
				operationId: "inbox.broken",
				parameters: [{ in: "path", name: "missing", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
			},
		},
	},
} as OpenApiDocument

type WaitOptions = Parameters<typeof driveWait>[0]

/* A server answering every poll with `handler`, closed after the test. */
async function pollServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
	const server = await listen(handler)
	closers.push(server.close)
	return server.url
}

/* driveWait against `url`, polling `spec.operationId`, with no record or scope unless given. */
function waitOn(url: string, options: Pick<WaitOptions, "spec"> & Partial<WaitOptions>) {
	const model = buildModel(dereference(WAIT_SPEC).doc)
	return driveWait({
		client: new Client({ baseUrl: url, redactor: new Redactor() }),
		headers: () => ({}),
		pollOp: model.byOperationId.get(options.spec.operationId)!,
		record: null,
		scope: {},
		writeOpId: "job.create",
		...options,
	})
}

describe("driveWait", () => {
	it("succeeds when the JSON path becomes occupied", async () => {
		let n = 0
		const url = await pollServer((_req, res) => {
			n += 1
			send(res, 200, n < 2 ? { items: [] } : { items: [{ id: "1" }] })
		})
		const pollOp = buildModel(dereference(WAIT_SPEC).doc).byOperationId.get("inbox.list")
		expect(pollOp).toBeDefined()
		const outcome = await waitOn(url, {
			spec: { operationId: "inbox.list", pollIntervalMs: 1, timeoutMs: 200, until: "$.items.0" },
		})
		expect(outcome.timedOut).toBe(false)
		expect(outcome.polls).toBeGreaterThanOrEqual(2)
		expect(outcome.matched).toEqual({ id: "1" })
	})

	it("succeeds from awaitSideEffect even when until is still empty", async () => {
		const url = await pollServer((_req, res) => send(res, 200, { items: [] }))
		const outcome = await waitOn(url, {
			awaitSideEffect: async () => true,
			spec: { operationId: "inbox.list", pollIntervalMs: 1, timeoutMs: 100, until: "$.items.0" },
		})
		expect(outcome.timedOut).toBe(false)
	})

	it("succeeds from awaitSideEffect when until is omitted", async () => {
		const url = await pollServer((_req, res) => send(res, 200, { items: [] }))
		let calls = 0
		const outcome = await waitOn(url, {
			awaitSideEffect: async () => {
				calls += 1
				return calls >= 2 ? true : null
			},
			record: { from: "write" },
			refreshIfStale: async () => undefined,
			spec: { operationId: "inbox.list", pollIntervalMs: 1, timeoutMs: 200 },
		})
		expect(outcome.timedOut).toBe(false)
		expect(calls).toBeGreaterThanOrEqual(2)
	})

	it("treats a 2xx occupied body as done when neither until nor hook is set", async () => {
		const url = await pollServer((_req, res) => send(res, 200, { ok: true }))
		const outcome = await waitOn(url, { spec: { operationId: "inbox.list", pollIntervalMs: 1, timeoutMs: 100 } })
		expect(outcome.timedOut).toBe(false)
	})
})

describe("driveWait", () => {
	it("keeps polling when the GET is not 2xx", async () => {
		const url = await pollServer((_req, res) => send(res, 404, { error: "empty" }))
		let hookRecord: unknown
		const outcome = await waitOn(url, {
			awaitSideEffect: async ({ record }) => {
				hookRecord = record
				return null
			},
			record: { from: "write" },
			spec: { operationId: "inbox.list", pollIntervalMs: 1, timeoutMs: 25, until: "$.items.0" },
		})
		expect(outcome.timedOut).toBe(true)
		expect(hookRecord).toEqual({ from: "write" })
	})

	it("stops polling once the wall clock budget is exhausted mid-request", async () => {
		const url = await pollServer((_req, res) => {
			void (async () => {
				await new Promise((done) => setTimeout(done, 20))
				send(res, 200, { items: [] })
			})()
		})
		const outcome = await waitOn(url, {
			spec: { operationId: "inbox.list", pollIntervalMs: 50, timeoutMs: 15, until: "$.items.0" },
		})
		expect(outcome.timedOut).toBe(true)
		expect(outcome.polls).toBe(1)
	})

	it("does not stop on a 4xx when there is no until and no hook", async () => {
		const url = await pollServer((_req, res) => send(res, 500, { error: "nope" }))
		const outcome = await waitOn(url, { spec: { operationId: "inbox.list", pollIntervalMs: 1, timeoutMs: 20 } })
		expect(outcome.timedOut).toBe(true)
	})

	it("times out and fails closed on an unresolvable poll path", async () => {
		const url = await pollServer((_req, res) => send(res, 200, { items: [] }))
		const empty = await waitOn(url, {
			spec: { operationId: "inbox.broken", pollIntervalMs: 1, timeoutMs: 30, until: "$.items.0" },
		})
		expect(empty.polls).toBe(0)
		expect(empty.timedOut).toBe(true)

		const timed = await waitOn(url, {
			spec: { operationId: "inbox.list", pollIntervalMs: 5, timeoutMs: 20, until: "$.items.0" },
		})
		expect(timed.timedOut).toBe(true)
		expect(timed.polls).toBeGreaterThan(0)
	})
})

const JOB_SPEC = {
	info: { title: "wait-run", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/jobs": {
			get: {
				operationId: "job.list",
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: {
									properties: {
										jobs: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
									},
									type: "object",
								},
							},
						},
						description: "ok",
					},
				},
				"x-entity": { action: "list", identity: "id", name: "job" },
			},
			post: {
				operationId: "job.create",
				requestBody: {
					content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
				},
				responses: {
					"201": {
						content: {
							"application/json": {
								schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
							},
						},
						description: "created",
					},
				},
				"x-entity": { action: "create", identity: "id", name: "job" },
				"x-wait": { operationId: "inbox.list", timeoutMs: 30, until: "$.items.0" },
			},
		},
		"/inbox": {
			get: {
				operationId: "inbox.list",
				responses: { "200": { description: "ok" } },
			},
		},
	},
} as OpenApiDocument

/* Jobs that are created, and an inbox that never receives anything. */
async function serveJobs(): Promise<string> {
	let jobs: Array<{ id: string; name: string }> = []
	const server = await listen((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			const method = (req.method ?? "GET").toUpperCase()
			if (url.pathname === "/openapi" && method === "GET") return send(res, 200, JOB_SPEC)
			if (url.pathname === "/jobs" && method === "GET") return send(res, 200, { jobs })
			if (url.pathname === "/jobs" && method === "POST") {
				const row = { id: `j${jobs.length + 1}`, name: "n" }
				jobs = [...jobs, row]
				return send(res, 201, row)
			}
			if (url.pathname === "/inbox" && method === "GET") return send(res, 200, { items: [] })
			return send(res, 404)
		})()
	})
	closers.push(server.close)
	return server.url
}

describe("effects.side-effect-arrives", () => {
	it("records a finding when the inbox stays empty", async () => {
		const url = await serveJobs()

		const result = await run({
			baseUrl: url,
			only: ["job"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${url}/openapi`,
		})
		expect(result.checksRun).toContain("effects.side-effect-arrives")
		const finding = result.findings.find((f) => f.check === "effects.side-effect-arrives")
		expect(finding?.verdict).toBe("BACKEND_BUG")
	})
})
