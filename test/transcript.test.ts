import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Client, describeRequestBody, toCurl } from "../src/runtime/client.ts"
import { INLINE_BODY_LIMIT, createExchangeJournal, isSecretJsonKey } from "../src/runtime/exchanges.ts"
import { isNetworkError } from "../src/runtime/network.ts"
import { run } from "../src/runtime/run.ts"
import {
	compactRequestBody,
	compactResponseBody,
	holdsLiveBody,
	isBodyRef,
	isFormSnapshot,
	readResponsePayload,
	releaseTranscriptBodies,
	sha256Hex,
} from "../src/runtime/transcript.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

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

async function scratch(): Promise<string> {
	return mkdtemp(join(tmpdir(), "oat-tr-"))
}

describe("body descriptors", () => {
	it("recognises refs, snapshots, and live payloads", () => {
		expect(isBodyRef(null)).toBe(false)
		expect(isBodyRef([])).toBe(false)
		expect(isBodyRef({ sha256: "a", bytes: 1 })).toBe(false)
		expect(isBodyRef({ bytes: 1, extra: true, mediaType: "text/plain", sha256: "a" })).toBe(false)
		expect(isBodyRef({ bytes: 1, mediaType: "text/plain", sha256: "a" })).toBe(true)
		expect(isFormSnapshot(null)).toBe(false)
		expect(isFormSnapshot([])).toBe(false)
		expect(isFormSnapshot({ parts: [], extra: 1 })).toBe(false)
		expect(isFormSnapshot({ parts: [] })).toBe(true)
		expect(holdsLiveBody(new FormData())).toBe(true)
		expect(holdsLiveBody(new URLSearchParams("a=1"))).toBe(true)
		expect(holdsLiveBody(new Blob([new Uint8Array([1])]))).toBe(true)
		expect(holdsLiveBody(new ArrayBuffer(4))).toBe(true)
		expect(holdsLiveBody(new Uint8Array([1, 2]))).toBe(true)
		expect(holdsLiveBody("z".repeat(INLINE_BODY_LIMIT + 1))).toBe(true)
		expect(holdsLiveBody("ok")).toBe(false)
		expect(holdsLiveBody({ n: 1 })).toBe(false)
		expect(isSecretJsonKey("password")).toBe(true)
		expect(isSecretJsonKey("name")).toBe(false)
	})

	it("compacts FormData, bytes, oversized text, and passes descriptors through", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4])
		const form = new FormData()
		form.append("title", "scan")
		form.append("password", "nope")
		form.append("file", new File([bytes], "a.bin"))
		const compacted = (await compactRequestBody(form)) as { parts: Array<Record<string, unknown>> }
		expect(isFormSnapshot(compacted)).toBe(true)
		expect(compacted.parts[0]).toEqual({ field: "title", value: "scan" })
		expect(compacted.parts[1]).toEqual({ field: "password", value: "<redacted>" })
		expect(compacted.parts[2]).toMatchObject({
			bytes: 4,
			field: "file",
			filename: "a.bin",
			mediaType: "application/octet-stream",
			sha256: sha256Hex(bytes),
		})
		expect(await compactRequestBody(compacted)).toBe(compacted)
		const ref = { bytes: 4, mediaType: "application/octet-stream", sha256: sha256Hex(bytes) }
		expect(await compactRequestBody(ref)).toBe(ref)
		expect(await compactRequestBody(undefined)).toBeUndefined()
		expect(await compactRequestBody(new URLSearchParams({ a: "1", token: "s" }))).toEqual({
			a: "1",
			token: "<redacted>",
		})
		expect(await compactRequestBody(bytes)).toEqual(ref)
		expect(await compactRequestBody(bytes.buffer)).toMatchObject({ bytes: 4, mediaType: "application/octet-stream" })
		expect(await compactRequestBody(new DataView(new ArrayBuffer(2)))).toMatchObject({ bytes: 2 })
		expect(await compactRequestBody(new Blob([bytes]))).toMatchObject({ bytes: 4 })
		expect(await compactRequestBody("hello")).toBe("hello")
		const huge = "z".repeat(INLINE_BODY_LIMIT + 8)
		expect(await compactRequestBody(huge)).toMatchObject({
			bytes: INLINE_BODY_LIMIT + 8,
			mediaType: "text/plain",
		})
		expect(await compactRequestBody({ n: 1 })).toEqual({ n: 1 })
		const bigJson = { blob: "w".repeat(INLINE_BODY_LIMIT + 8) }
		expect(await compactRequestBody(bigJson)).toMatchObject({ mediaType: "application/json" })
		expect(await compactRequestBody(7)).toBe(7)
		expect(describeRequestBody(form)).toMatchObject({
			file: { bytes: 4, filename: "a.bin" },
			password: "nope",
			title: "scan",
		})
		expect(describeRequestBody(compacted)).toEqual({
			file: { bytes: 4, filename: "a.bin", mediaType: "application/octet-stream" },
			password: "<redacted>",
			title: "scan",
		})
		expect(describeRequestBody(ref)).toEqual({
			bytes: 4,
			mediaType: "application/octet-stream",
			sha256: sha256Hex(bytes),
		})
		const curl = toCurl({ method: "POST", requestBody: compacted, requestHeaders: {}, url: "http://x.test/" } as never)
		expect(curl).toContain("-F 'title=scan'")
		expect(curl).toContain("-F 'file=@a.bin;type=application/octet-stream'")
		expect(toCurl({ method: "POST", requestBody: ref, requestHeaders: {}, url: "http://x.test/" } as never)).toContain(
			"--data-binary @-",
		)
	})

	it("compacts SSE frames, oversized responses, and binary bodies", async () => {
		expect(await compactResponseBody(undefined, {})).toBeUndefined()
		const ref = { bytes: 3, mediaType: "text/plain", sha256: "abc" }
		expect(await compactResponseBody(ref, {})).toBe(ref)
		const snap = { parts: [{ field: "a", value: "1" }] }
		expect(await compactResponseBody(snap, {})).toBe(snap)
		const frames = [
			{ data: { n: 1 }, event: "batch" },
			{ data: { status: "complete" }, event: "complete" },
		]
		expect(await compactResponseBody(frames, { "content-type": "text/event-stream" })).toEqual(frames)
		expect(
			await compactResponseBody('event: batch\ndata: {"n":1}\n\n', { "content-type": "text/event-stream" }),
		).toEqual([{ data: { n: 1 }, event: "batch" }])
		expect(await compactResponseBody("not a frame", { "content-type": "text/event-stream" })).toBe("not a frame")
		const huge = "x".repeat(INLINE_BODY_LIMIT + 4)
		expect(await compactResponseBody(huge, { "content-type": "text/event-stream" })).toMatchObject({
			mediaType: "text/event-stream",
		})
		expect(await compactResponseBody(`data: ${huge}\n\n`, { "content-type": "text/event-stream" })).toMatchObject({
			mediaType: "text/event-stream",
		})
		expect(await compactResponseBody(huge, { "content-type": "text/plain" })).toMatchObject({ mediaType: "text/plain" })
		expect(await compactResponseBody("hello", { "content-type": "text/plain" })).toBe("hello")
		expect(await compactResponseBody("%PDF", { "content-type": "application/pdf" })).toMatchObject({
			mediaType: "application/pdf",
		})
		expect(
			await compactResponseBody(new Uint8Array([1, 2]), { "content-type": "application/octet-stream" }),
		).toMatchObject({ bytes: 2 })
		expect(
			await compactResponseBody(new Blob([new Uint8Array([9])]), { "content-type": "application/octet-stream" }),
		).toMatchObject({ bytes: 1 })
		expect(await compactResponseBody({ ok: true }, { "content-type": "application/json" })).toEqual({ ok: true })
		expect(await compactResponseBody({ blob: huge }, { "content-type": "application/json" })).toMatchObject({
			mediaType: "application/json",
		})
		expect(await compactResponseBody([{ id: "1" }], {})).toEqual([{ id: "1" }])
		expect(await compactResponseBody(0, {})).toBe(0)
		expect(await compactResponseBody("hello", { "content-type": "  ", "CONTENT-TYPE": "text/plain" })).toBe("hello")
		const giantFrames = [{ data: huge, event: "chunk" }]
		expect(await compactResponseBody(giantFrames, { "content-type": "text/event-stream" })).toMatchObject({
			mediaType: "text/event-stream",
		})
	})
})

describe("readResponsePayload", () => {
	it("parses JSON, empty, and raw text", async () => {
		expect(await readResponsePayload(new Response("", { headers: { "content-type": "application/json" } }))).toEqual({
			bodyBytes: 0,
			parsed: null,
		})
		expect(
			await readResponsePayload(new Response('{"ok":true}', { headers: { "content-type": "application/json" } })),
		).toEqual({ bodyBytes: '{"ok":true}'.length, parsed: { ok: true } })
		expect(await readResponsePayload(new Response("not-json", { headers: { "content-type": "text/plain" } }))).toEqual({
			bodyBytes: "not-json".length,
			parsed: "not-json",
		})
	})

	it("parses SSE from a body-less Response via text()", async () => {
		const empty = new Response(null, { headers: { "content-type": "text/event-stream" } })
		expect(await readResponsePayload(empty)).toEqual({ bodyBytes: 0, parsed: "" })
		const framed = new Response('event: batch\ndata: {"n":1}\n\n', {
			headers: { "content-type": "text/event-stream" },
		})
		Object.defineProperty(framed, "body", { configurable: true, value: null })
		expect(await readResponsePayload(framed)).toEqual({
			bodyBytes: 'event: batch\ndata: {"n":1}\n\n'.length,
			parsed: [{ data: { n: 1 }, event: "batch" }],
		})
		const huge = `:${"x".repeat(INLINE_BODY_LIMIT + 8)}`
		const oversized = new Response(huge, { headers: { "content-type": "text/event-stream" } })
		Object.defineProperty(oversized, "body", { configurable: true, value: null })
		const spilled = await readResponsePayload(oversized)
		expect(isBodyRef(spilled.parsed)).toBe(true)
		expect((spilled.parsed as { mediaType: string }).mediaType).toBe("text/event-stream")
	})

	it("parses a live SSE stream in chunks and drops the raw concatenation", async () => {
		const server = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write("event: batch\n")
			res.write('data: {"n":1}\n\n')
			res.end('event: complete\ndata: {"status":"complete"}\n\n')
		})
		closers.push(server.close)
		const response = await fetch(`${server.url}/stream`)
		const payload = await readResponsePayload(response)
		expect(payload.parsed).toEqual([
			{ data: { n: 1 }, event: "batch" },
			{ data: { status: "complete" }, event: "complete" },
		])
		expect(typeof payload.parsed).not.toBe("string")
	})

	it("spills an unframed oversized event-stream while hashing chunks", async () => {
		const huge = "not-a-frame-" + "x".repeat(INLINE_BODY_LIMIT)
		const server = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.end(huge)
		})
		closers.push(server.close)
		const payload = await readResponsePayload(await fetch(`${server.url}/stream`))
		expect(isBodyRef(payload.parsed)).toBe(true)
		expect((payload.parsed as { bytes: number }).bytes).toBeGreaterThan(INLINE_BODY_LIMIT)
	})

	it("keeps a small unframed event-stream as text", async () => {
		const server = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "TEXT/EVENT-STREAM" })
			res.end('{"ok":true}')
		})
		closers.push(server.close)
		expect((await readResponsePayload(await fetch(`${server.url}/stream`))).parsed).toBe('{"ok":true}')
	})

	it("keeps parsed frames when a framed stream exceeds the inline cap", async () => {
		const data = "x".repeat(INLINE_BODY_LIMIT)
		const server = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.end(`event: chunk\ndata: ${data}\n\n`)
		})
		closers.push(server.close)
		const payload = await readResponsePayload(await fetch(`${server.url}/stream`))
		expect(payload.parsed).toEqual([{ data, event: "chunk" }])
	})

	it("ignores an empty stream chunk", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(undefined as unknown as Uint8Array)
				controller.enqueue(new TextEncoder().encode("data: hi\n\n"))
				controller.close()
			},
		})
		const payload = await readResponsePayload(
			new Response(stream, { headers: { "content-type": "text/event-stream" } }),
		)
		expect(payload.parsed).toEqual([{ data: "hi", event: "message" }])
	})

	it("flushes a trailing TextDecoder remainder", async () => {
		const small = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: hi\n\n"))
				controller.enqueue(new Uint8Array([0xe2]))
				controller.close()
			},
		})
		expect(
			(await readResponsePayload(new Response(small, { headers: { "content-type": "text/event-stream" } }))).parsed,
		).toEqual([{ data: "hi", event: "message" }])

		const large = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("not-a-frame-" + "x".repeat(INLINE_BODY_LIMIT)))
				controller.enqueue(new Uint8Array([0xe2]))
				controller.close()
			},
		})
		const spilled = await readResponsePayload(new Response(large, { headers: { "content-type": "text/event-stream" } }))
		expect(isBodyRef(spilled.parsed)).toBe(true)
	})

	it("propagates a stream read error", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }))
			},
		})
		const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
		await expect(readResponsePayload(response)).rejects.toSatisfy(
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		)
	})
})

describe("Client transcript lifecycle", () => {
	it("replaces live FormData with a snapshot after the journal records it", async () => {
		const dir = await scratch()
		const journal = createExchangeJournal(dir)
		const bytes = new Uint8Array(64).fill(7)
		const server = await listen((_req, res) => {
			res.writeHead(201, { "content-type": "application/json" })
			res.end(JSON.stringify({ id: "1" }))
		})
		closers.push(server.close)
		const client = new Client(server.url, {}, 1, (exchange) => journal.record(exchange))
		const form = new FormData()
		form.append("note", "hi")
		form.append("file", new File([bytes], "blob.bin", { type: "application/octet-stream" }))
		const exchange = await client.request("POST", "/upload", {
			body: form,
			fixture: "blob.bin",
			operationId: "upload.once",
		})
		/* The transcript keeps a compact copy; the caller keeps the real body. */
		const stored = client.transcript.at(-1)
		expect(holdsLiveBody(stored?.requestBody)).toBe(false)
		expect(isFormSnapshot(stored?.requestBody)).toBe(true)
		expect(exchange.requestBody).toBe(form)
		expect(exchange.responseBody).toEqual({ id: "1" })
		expect(exchange.fixture).toBe("blob.bin")
		const file = JSON.parse(
			await readFile(join(dir, "exchanges", `${exchange.requestId || `seq-${exchange.seq}`}.json`), "utf8"),
		) as {
			requestBody: { parts: Array<Record<string, unknown>> }
		}
		const listing = await readdir(join(dir, "exchanges"))
		const recorded = JSON.parse(await readFile(join(dir, "exchanges", listing[0] ?? ""), "utf8")) as {
			requestBody: { parts: Array<Record<string, unknown>> }
		}
		expect(recorded.requestBody.parts[1]).toMatchObject({
			bytes: 64,
			field: "file",
			filename: "blob.bin",
			sha256: sha256Hex(bytes),
		})
		expect(existsSync(join(dir, "blobs", sha256Hex(bytes)))).toBe(true)
		expect(file.requestBody.parts[1]?.sha256).toBe(sha256Hex(bytes))
	})

	it("compacts a failed attempt so a timeout cannot leave a live FormData on the transcript", async () => {
		const server = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write('event: progress\ndata: {"n":1}\n\n')
		})
		closers.push(server.close)
		const form = new FormData()
		form.append("file", new File([new Uint8Array(32).fill(1)], "hang.bin"))
		const client = new Client(server.url, {}, 1, undefined, undefined, undefined, {
			requestTimeoutMs: 80,
			retries: 0,
		})
		await expect(client.request("POST", "/stream", { body: form })).rejects.toSatisfy(
			(error: unknown) => isNetworkError(error) && error.kind === "timeout",
		)
		expect(client.transcript).toHaveLength(1)
		expect(holdsLiveBody(client.transcript[0]?.requestBody)).toBe(false)
		expect(client.transcript[0]?.responseBody).toMatchObject({ error: "network", kind: "timeout" })
		expect(typeof client.transcript[0]?.responseBody).not.toBe("string")
	})

	it("keeps citeable metadata after release", async () => {
		const exchange = {
			at: 1,
			durationMs: 1,
			method: "POST",
			requestBody: (() => {
				const form = new FormData()
				form.append("title", "t")
				return form
			})(),
			requestBytes: 10,
			requestHeaders: { authorization: "Bearer x" },
			requestId: "r1",
			responseBody: "z".repeat(INLINE_BODY_LIMIT + 2),
			responseBytes: 10,
			responseHeaders: { "content-type": "text/plain" },
			seq: 1,
			status: 200,
			url: "http://x.test/v1/x",
			fixture: "a.bin",
			operationId: "upload.once",
		}
		await releaseTranscriptBodies(exchange)
		expect(exchange.method).toBe("POST")
		expect(exchange.url).toBe("http://x.test/v1/x")
		expect(exchange.status).toBe(200)
		expect(exchange.requestId).toBe("r1")
		expect(exchange.operationId).toBe("upload.once")
		expect(exchange.fixture).toBe("a.bin")
		expect(isFormSnapshot(exchange.requestBody)).toBe(true)
		expect(isBodyRef(exchange.responseBody)).toBe(true)
	})
})

describe("uploads.each fan-out does not scale RSS with fixtureBytes × N", () => {
	it("journals unique parts and keeps transcript descriptors", { timeout: 30_000 }, async () => {
		const n = 8
		const partSize = 512 * 1024
		const server = await listen((req, res) => {
			void (async () => {
				req.resume()
				await new Promise<void>((resolve, reject) => {
					req.on("end", resolve)
					req.on("error", reject)
				})
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify({ id: "1" }))
			})().catch(() => {
				if (!res.headersSent) res.writeHead(500)
				res.end()
			})
		})
		closers.push(server.close)
		const exchangeDir = await scratch()
		const journal = createExchangeJournal(exchangeDir)
		const client = new Client(server.url, {}, 2, (exchange) => journal.record(exchange))
		await client.request("GET", "/warmup")
		const files: WeakRef<File>[] = []
		const digests: string[] = []
		const postOnce = async (i: number): Promise<void> => {
			const bytes = new Uint8Array(partSize)
			bytes.fill(i + 1)
			bytes[0] = i
			digests.push(createHash("sha256").update(bytes).digest("hex"))
			const file = new File([bytes], `part-${i}.bin`, { type: "application/octet-stream" })
			files.push(new WeakRef(file))
			const form = new FormData()
			form.append("file", file)
			await client.request("POST", "/uploads", {
				body: form,
				fixture: `part-${i}.bin`,
				operationId: "upload.once",
			})
		}
		for (let i = 0; i < n; i++) await postOnce(i)
		const product = n * partSize
		const posts = client.transcript.filter((e) => e.method === "POST")
		expect(posts).toHaveLength(n)
		expect(posts.every((e) => !holdsLiveBody(e.requestBody))).toBe(true)
		expect(posts.every((e) => isFormSnapshot(e.requestBody))).toBe(true)
		expect(posts.every((e) => e.fixture?.startsWith("part-") === true)).toBe(true)
		const retained = Buffer.byteLength(JSON.stringify(posts.map((e) => ({ req: e.requestBody, res: e.responseBody }))))
		expect(retained).toBeLessThan(64 * 1024)
		expect(retained).toBeLessThan(product / 16)
		const blobs = await readdir(join(exchangeDir, "blobs"))
		expect(blobs).toHaveLength(n)
		for (const digest of digests) {
			expect(blobs).toContain(digest)
			expect(existsSync(join(exchangeDir, "blobs", digest))).toBe(true)
		}
		expect(journal.count).toBe(n + 1)
		if (typeof globalThis.gc === "function") {
			globalThis.gc()
			await new Promise<void>((resolve) => {
				setImmediate(resolve)
			})
			globalThis.gc()
			expect(files.filter((ref) => ref.deref() !== undefined).length).toBeLessThanOrEqual(1)
		}
	})

	it("run() with uploads.each leaves descriptors, not live FormData", async () => {
		const dir = await scratch()
		await writeFile(join(dir, "one.bin"), new Uint8Array(32).fill(1))
		await writeFile(join(dir, "two.bin"), new Uint8Array(32).fill(2))
		const spec: OpenApiDocument = {
			info: { title: "upload", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/uploads": {
					get: {
						operationId: "upload.list",
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: {
											properties: {
												uploads: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
											},
											type: "object",
										},
									},
								},
								description: "ok",
							},
						},
						"x-entity": { action: "list", identity: "id", name: "upload" },
					},
					post: {
						operationId: "upload.once",
						requestBody: {
							content: {
								"multipart/form-data": {
									schema: {
										properties: {
											file: { contentMediaType: "application/octet-stream", format: "binary", type: "string" },
										},
										required: ["file"],
										type: "object",
									},
								},
							},
							required: true,
						},
						responses: {
							"201": {
								content: {
									"application/json": { schema: { properties: { id: { type: "string" } }, type: "object" } },
								},
								description: "created",
							},
						},
						"x-entity": { action: "create", identity: "id", name: "upload" },
					},
				},
			},
		} as OpenApiDocument
		let seq = 0
		const server = await listen((req, res) => {
			void (async () => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1")
				if (url.pathname === "/openapi.json") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify(spec))
					return
				}
				if ((req.method ?? "").toUpperCase() === "GET" && url.pathname === "/uploads") {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(JSON.stringify({ uploads: [] }))
					return
				}
				req.resume()
				await new Promise<void>((resolve, reject) => {
					req.on("end", resolve)
					req.on("error", reject)
				})
				res.writeHead(201, { "content-type": "application/json" })
				res.end(JSON.stringify({ id: `u_${(seq += 1)}` }))
			})().catch(() => {
				if (!res.headersSent) res.writeHead(500)
				res.end()
			})
		})
		closers.push(server.close)
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			configDir: dir,
			network: { retries: 0, waitMs: 0 },
			only: ["upload"],
			principals: [{ headers: {}, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/openapi.json`,
			uploads: { each: { "upload.once": ["./*.bin"] }, eachMax: 2 },
		})
		const posts = result.client.transcript.filter((e) => e.method === "POST" && new URL(e.url).pathname === "/uploads")
		expect(posts.length).toBeGreaterThanOrEqual(2)
		expect(posts.every((e) => isFormSnapshot(e.requestBody))).toBe(true)
		expect(posts.every((e) => !holdsLiveBody(e.requestBody))).toBe(true)
		expect(posts.some((e) => e.fixture === "one.bin" || e.fixture === "two.bin")).toBe(true)
	})
})

describe("run() times out a hung stream as a network outcome", () => {
	it("does not leave a giant partial buffer on the transcript", async () => {
		const spec: OpenApiDocument = {
			info: { title: "hang", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/items": {
					get: {
						operationId: "item.list",
						responses: { "200": { description: "ok" } },
						"x-entity": { action: "list", identity: "id", name: "item" },
					},
					post: {
						operationId: "item.create",
						requestBody: {
							content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
						},
						responses: { "201": { description: "ok" } },
						"x-entity": { action: "create", identity: "id", name: "item" },
					},
				},
			},
		} as OpenApiDocument
		const server = await listen((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1")
			if (url.pathname === "/openapi.json") {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify(spec))
				return
			}
			if (url.pathname === "/v1/items" && (req.method ?? "") === "GET") {
				res.writeHead(200, { "content-type": "text/event-stream" })
				res.write(`:${"y".repeat(1024)}\n`)
				return
			}
			res.writeHead(201, { "content-type": "application/json" })
			res.end(JSON.stringify({ id: "1", name: "n" }))
		})
		closers.push(server.close)
		const result = await run({
			baseUrl: server.url,
			cohortSize: 1,
			network: { requestTimeoutMs: 120, retries: 0, waitMs: 0 },
			only: ["item"],
			principals: [{ headers: { authorization: "Bearer t" }, id: "alpha" }],
			seed: 1,
			spec: `${server.url}/openapi.json`,
		})
		expect(result.network?.incomplete).toBe(true)
		expect(result.network?.kind).toBe("timeout")
		expect(result.findings.some((f) => f.check === "net.unreachable")).toBe(true)
		for (const exchange of result.client.transcript) {
			expect(holdsLiveBody(exchange.requestBody)).toBe(false)
			expect(holdsLiveBody(exchange.responseBody)).toBe(false)
			if (typeof exchange.responseBody === "string") {
				expect(exchange.responseBody.length).toBeLessThanOrEqual(INLINE_BODY_LIMIT)
			}
		}
	})
})

describe("a large body stored by reference", () => {
	it("names the bytes the server sent, not a re-encoding of them", async () => {
		/* Spacing JSON.stringify would not reproduce: hashing the parsed value would miss it. */
		const sent = `{ "rows" : [ ${Array.from({ length: 4000 }, (_, i) => `{ "id" : ${i}, "name" : "${"n".repeat(60)}" }`).join(" , ")} ] }`
		const server = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(sent)
		})
		closers.push(server.close)
		const client = new Client(server.url)
		const exchange = await client.request("GET", "/rows")
		const stored = { ...exchange }
		await releaseTranscriptBodies(stored)
		const raw = Buffer.from(sent)
		expect(stored.responseBody).toEqual({
			bytes: raw.byteLength,
			mediaType: "application/json",
			sha256: sha256Hex(raw),
		})
	})
})
