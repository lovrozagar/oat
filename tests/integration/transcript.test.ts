import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import { toCurl } from "../../src/client/curl.ts"
import { describeRequestBody } from "../../src/runtime/exchange.ts"
import { INLINE_BODY_LIMIT } from "../../src/runtime/exchanges/media.ts"
import { isSecretJsonKey } from "../../src/security/credential-names.ts"
import { Redactor } from "../../src/security/redact.ts"
import { compactRequestBody } from "../../src/runtime/transcript/compact-request.ts"
import { compactResponseBody } from "../../src/runtime/transcript/compact-response.ts"
import { holdsLiveBody } from "../../src/runtime/transcript/live.ts"
import { isBodyRef, isFormSnapshot } from "../../src/runtime/exchange.ts"
import { readResponsePayload } from "../../src/runtime/transcript/payload.ts"
import { releaseTranscriptBodies } from "../../src/runtime/transcript/release.ts"
import { sha256Hex } from "../../src/runtime/exchanges/bytes.ts"
import { type Listening, listen } from "../support/transcript-fixtures.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

/* Registers a started server for teardown. */
async function track(started: Promise<Listening>): Promise<Listening> {
	const server = await started
	closers.push(server.close)
	return server
}

function recognisesDescriptors() {
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
}

type Snapshot = { parts: Array<Record<string, unknown>> }

/* Descriptors pass through; bytes, blobs and oversized text become refs; small values stay inline. */
async function expectBodiesCompacted(bytes: Uint8Array, compacted: Snapshot, ref: object): Promise<void> {
	expect(await compactRequestBody(compacted, new Redactor())).toBe(compacted)
	expect(await compactRequestBody(ref, new Redactor())).toBe(ref)
	expect(await compactRequestBody(undefined, new Redactor())).toBeUndefined()
	expect(await compactRequestBody(new URLSearchParams({ a: "1", token: "s" }), new Redactor())).toEqual({
		a: "1",
		token: "<redacted>",
	})
	expect(await compactRequestBody(bytes, new Redactor())).toEqual(ref)
	expect(await compactRequestBody(bytes.buffer, new Redactor())).toMatchObject({
		bytes: 4,
		mediaType: "application/octet-stream",
	})
	expect(await compactRequestBody(new DataView(new ArrayBuffer(2)), new Redactor())).toMatchObject({ bytes: 2 })
	expect(await compactRequestBody(new Blob([bytes]), new Redactor())).toMatchObject({ bytes: 4 })
	expect(await compactRequestBody("hello", new Redactor())).toBe("hello")
	const huge = "z".repeat(INLINE_BODY_LIMIT + 8)
	expect(await compactRequestBody(huge, new Redactor())).toMatchObject({
		bytes: INLINE_BODY_LIMIT + 8,
		mediaType: "text/plain",
	})
	expect(await compactRequestBody({ n: 1 }, new Redactor())).toEqual({ n: 1 })
	const bigJson = { blob: "w".repeat(INLINE_BODY_LIMIT + 8) }
	expect(await compactRequestBody(bigJson, new Redactor())).toMatchObject({ mediaType: "application/json" })
	expect(await compactRequestBody(7, new Redactor())).toBe(7)
}

/* A stored body's ref, and the bytes it names. */
interface StoredBody {
	ref: object
	bytes: Uint8Array
}

/* The live form, its snapshot and a ref each describe and render as curl. */
function expectDescribedAndCurled(form: FormData, compacted: Snapshot, { bytes, ref }: StoredBody): void {
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
	const curl = toCurl({ method: "POST", requestBody: compacted, requestHeaders: {}, url: "http://x.test/" } as never, {
		redactor: new Redactor(),
	})
	expect(curl).toContain("-F 'title=scan'")
	expect(curl).toContain("-F 'file=@a.bin;type=application/octet-stream'")
	expect(
		toCurl({ method: "POST", requestBody: ref, requestHeaders: {}, url: "http://x.test/" } as never, {
			redactor: new Redactor(),
		}),
	).toContain("--data-binary @-")
}

async function compactsRequestBodies() {
	const bytes = new Uint8Array([1, 2, 3, 4])
	const form = new FormData()
	form.append("title", "scan")
	form.append("password", "nope")
	form.append("file", new File([bytes], "a.bin"))
	/* A form compacts to a snapshot: text kept, secrets redacted, the file named by its digest. */
	const compacted = (await compactRequestBody(form, new Redactor())) as Snapshot
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
	const ref = { bytes: 4, mediaType: "application/octet-stream", sha256: sha256Hex(bytes) }
	await expectBodiesCompacted(bytes, compacted, ref)
	expectDescribedAndCurled(form, compacted, { bytes, ref })
}

async function compactsResponseBodies() {
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
	expect(await compactResponseBody('event: batch\ndata: {"n":1}\n\n', { "content-type": "text/event-stream" })).toEqual(
		[{ data: { n: 1 }, event: "batch" }],
	)
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
}

describe("body descriptors", () => {
	it("recognises refs, snapshots, and live payloads", recognisesDescriptors)
	it("compacts FormData, bytes, oversized text, and passes descriptors through", compactsRequestBodies)
	it("compacts SSE frames, oversized responses, and binary bodies", compactsResponseBodies)
})

async function parsesJsonEmptyAndText() {
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
}

async function parsesBodylessSse() {
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
}

async function parsesLiveSseInChunks() {
	const server = await track(
		listen((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write("event: batch\n")
			res.write('data: {"n":1}\n\n')
			res.end('event: complete\ndata: {"status":"complete"}\n\n')
		}),
	)
	const response = await fetch(`${server.url}/stream`)
	const payload = await readResponsePayload(response)
	expect(payload.parsed).toEqual([
		{ data: { n: 1 }, event: "batch" },
		{ data: { status: "complete" }, event: "complete" },
	])
	expect(typeof payload.parsed).not.toBe("string")
}

/* Serves one body under the given content type, an event stream by default. */
function serveOnce(body: string, contentType = "text/event-stream"): Promise<Listening> {
	return track(
		listen((_req, res) => {
			res.writeHead(200, { "content-type": contentType })
			res.end(body)
		}),
	)
}

async function spillsUnframedOversized() {
	const huge = "not-a-frame-" + "x".repeat(INLINE_BODY_LIMIT)
	const server = await serveOnce(huge)
	const payload = await readResponsePayload(await fetch(`${server.url}/stream`))
	expect(isBodyRef(payload.parsed)).toBe(true)
	expect((payload.parsed as { bytes: number }).bytes).toBeGreaterThan(INLINE_BODY_LIMIT)
}

async function keepsSmallUnframedText() {
	const server = await serveOnce('{"ok":true}', "TEXT/EVENT-STREAM")
	expect((await readResponsePayload(await fetch(`${server.url}/stream`))).parsed).toBe('{"ok":true}')
}

async function keepsFramesOverCap() {
	const data = "x".repeat(INLINE_BODY_LIMIT)
	const server = await serveOnce(`event: chunk\ndata: ${data}\n\n`)
	const payload = await readResponsePayload(await fetch(`${server.url}/stream`))
	expect(payload.parsed).toEqual([{ data, event: "chunk" }])
}

/* An event-stream response that enqueues each chunk in order, then closes. */
function chunkedStream(chunks: Array<Uint8Array | undefined>): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk as Uint8Array)
			controller.close()
		},
	})
	return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

async function ignoresEmptyChunk() {
	const payload = await readResponsePayload(chunkedStream([undefined, new TextEncoder().encode("data: hi\n\n")]))
	expect(payload.parsed).toEqual([{ data: "hi", event: "message" }])
}

async function flushesDecoderRemainder() {
	const small = chunkedStream([new TextEncoder().encode("data: hi\n\n"), new Uint8Array([0xe2])])
	expect((await readResponsePayload(small)).parsed).toEqual([{ data: "hi", event: "message" }])
	const large = chunkedStream([
		new TextEncoder().encode("not-a-frame-" + "x".repeat(INLINE_BODY_LIMIT)),
		new Uint8Array([0xe2]),
	])
	const spilled = await readResponsePayload(large)
	expect(isBodyRef(spilled.parsed)).toBe(true)
}

async function propagatesReadError() {
	const stream = new ReadableStream({
		start(controller) {
			controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }))
		},
	})
	const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
	await expect(readResponsePayload(response)).rejects.toSatisfy(
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	)
}

describe("readResponsePayload", () => {
	it("parses JSON, empty, and raw text", parsesJsonEmptyAndText)
	it("parses SSE from a body-less Response via text()", parsesBodylessSse)
	it("parses a live SSE stream in chunks and drops the raw concatenation", parsesLiveSseInChunks)
	it("spills an unframed oversized event-stream while hashing chunks", spillsUnframedOversized)
	it("keeps a small unframed event-stream as text", keepsSmallUnframedText)
	it("keeps parsed frames when a framed stream exceeds the inline cap", keepsFramesOverCap)
	it("ignores an empty stream chunk", ignoresEmptyChunk)
	it("flushes a trailing TextDecoder remainder", flushesDecoderRemainder)
	it("propagates a stream read error", propagatesReadError)
})

async function namesTextByDigest() {
	const digest = { bytes: INLINE_BODY_LIMIT + 1, sha256: "ab".repeat(32) }
	expect(await compactRequestBody("x".repeat(INLINE_BODY_LIMIT + 1), new Redactor(), { digest: digest })).toEqual({
		...digest,
		mediaType: "text/plain",
	})
}

async function namesSentRequestBytes() {
	let received = Buffer.alloc(0)
	const server = await track(
		listen((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				received = Buffer.concat(chunks)
				res.writeHead(201, { "content-type": "application/json" }).end('{"id":"1"}')
			})
		}),
	)
	const client = new Client({ baseUrl: server.url, redactor: new Redactor() })
	const body = { rows: Array.from({ length: 4000 }, (_, i) => ({ id: i, name: "n".repeat(60) })) }
	const exchange = await client.request("POST", "/rows", { as: { anonymous: true }, body })
	const stored = { ...exchange }
	await releaseTranscriptBodies(stored, new Redactor())
	expect(received.byteLength).toBeGreaterThan(INLINE_BODY_LIMIT)
	expect(stored.requestBody).toEqual({
		bytes: received.byteLength,
		mediaType: "application/json",
		sha256: sha256Hex(received),
	})
}

async function namesServerBytes() {
	/* Spacing JSON.stringify would not reproduce: hashing the parsed value would miss it. */
	const sent = `{ "rows" : [ ${Array.from({ length: 4000 }, (_, i) => `{ "id" : ${i}, "name" : "${"n".repeat(60)}" }`).join(" , ")} ] }`
	const server = await serveOnce(sent, "application/json")
	const client = new Client({ baseUrl: server.url, redactor: new Redactor() })
	const exchange = await client.request("GET", "/rows", { as: { anonymous: true } })
	const stored = { ...exchange }
	await releaseTranscriptBodies(stored, new Redactor())
	const raw = Buffer.from(sent)
	expect(stored.responseBody).toEqual({
		bytes: raw.byteLength,
		mediaType: "application/json",
		sha256: sha256Hex(raw),
	})
}

describe("a large body stored by reference", () => {
	it("names a large text request by the digest taken when it was sent", namesTextByDigest)
	it("names the request bytes that were sent", namesSentRequestBytes)
	it("names the bytes the server sent, not a re-encoding of them", namesServerBytes)
})
