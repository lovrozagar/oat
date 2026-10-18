import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../../src/runtime/exchange.ts"
import { createExchangeJournal } from "../../src/runtime/exchanges/journal.ts"
import { INLINE_BODY_LIMIT } from "../../src/runtime/exchanges/media.ts"
import { Redactor } from "../../src/security/redact.ts"
import { exchange, readSaved, scratch } from "../support/exchanges-fixtures.ts"

type Journal = ReturnType<typeof createExchangeJournal>

/** Records each row and flushes after each, in order. */
async function recordEach(journal: Journal, rows: readonly Partial<Exchange>[]): Promise<void> {
	for (const row of rows) {
		await journal.record(exchange(row))
		await journal.flush()
	}
}

async function journalIn(): Promise<{ dir: string; journal: Journal }> {
	const dir = await scratch()
	return { dir, journal: createExchangeJournal(dir, new Redactor()) }
}

const EVENT_STREAM = { "content-type": "text/event-stream" }

async function storesParsedFrames(): Promise<void> {
	const { dir, journal } = await journalIn()
	await recordEach(journal, [
		{
			requestId: "sse-frames",
			responseBody: [{ data: { access_token: "nope", n: 1 }, event: "batch" }],
			responseHeaders: EVENT_STREAM,
			seq: 1,
		},
	])
	const file = await readSaved<{ responseBody: unknown }>(dir, "exchanges/sse-frames.json")
	expect(file.responseBody).toEqual([{ data: { access_token: "<redacted>", n: 1 }, event: "batch" }])
}

async function storesSseAsFrames(): Promise<void> {
	const { dir, journal } = await journalIn()
	await recordEach(journal, [
		{
			requestId: "sse-1",
			responseBody: 'event: batch\ndata: {"access_token":"nope","n":1}\n\n',
			responseHeaders: EVENT_STREAM,
			seq: 1,
		},
	])
	const file = await readSaved<{ responseBody: Array<{ event: string; data: Record<string, unknown> }> }>(
		dir,
		"exchanges/sse-1.json",
	)
	expect(file.responseBody).toEqual([{ data: { access_token: "<redacted>", n: 1 }, event: "batch" }])
	expect(JSON.stringify(file)).not.toContain("nope")
}

async function keepsUnframedStream(): Promise<void> {
	const { dir, journal } = await journalIn()
	await recordEach(journal, [
		{ requestId: "sse-raw", responseBody: "not a frame", responseHeaders: EVENT_STREAM, seq: 1 },
	])
	const file = await readSaved<{ responseBody: unknown }>(dir, "exchanges/sse-raw.json")
	expect(file.responseBody).toBe("not a frame")
}

async function guessesFramesWithoutHeader(): Promise<void> {
	const { dir, journal } = await journalIn()
	await recordEach(journal, [
		{
			requestId: "sse-guess",
			responseBody: 'data: {"ok":true}\n\n',
			responseHeaders: { "content-type": "text/plain" },
			seq: 1,
		},
	])
	const file = await readSaved<{ responseBody: unknown }>(dir, "exchanges/sse-guess.json")
	expect(file.responseBody).toEqual([{ data: { ok: true }, event: "message" }])
}

describe("exchange journal: event streams", () => {
	it("stores already-parsed SSE frames with redaction", storesParsedFrames)
	it("stores SSE as parsed frames, not a raw dump", storesSseAsFrames)
	it("keeps an event-stream body as text when it is not framed", keepsUnframedStream)
	it("parses SSE frames from a raw string even without the event-stream header", guessesFramesWithoutHeader)
})

type BlobRef = { sha256: string; bytes: number; mediaType: string }

async function spillsOversized(): Promise<void> {
	const { dir, journal } = await journalIn()
	await recordEach(journal, [
		{
			method: "POST",
			requestBody: "z".repeat(INLINE_BODY_LIMIT + 8),
			requestId: "big-text",
			responseBody: { blob: "w".repeat(INLINE_BODY_LIMIT + 8) },
			responseHeaders: { "content-type": "application/json" },
			seq: 1,
		},
	])
	const file = await readSaved<{ requestBody: BlobRef; responseBody: BlobRef }>(dir, "exchanges/big-text.json")
	expect(file.requestBody.bytes).toBeGreaterThan(INLINE_BODY_LIMIT)
	expect(file.requestBody.mediaType).toBe("text/plain")
	expect(file.responseBody.mediaType).toBe("application/json")
	expect(existsSync(join(dir, "blobs", file.requestBody.sha256))).toBe(true)
	expect(existsSync(join(dir, "blobs", file.responseBody.sha256))).toBe(true)
}

async function storesBinaryAsPointer(): Promise<void> {
	const { dir, journal } = await journalIn()
	const pdf = { "content-type": "application/pdf" }
	await recordEach(journal, [
		{ requestId: "pdf", responseBody: "%PDF-1.4 fake", responseHeaders: pdf, seq: 1 },
		{ requestId: "pdf-obj", responseBody: { note: "not-bytes" }, responseHeaders: pdf, seq: 2 },
	])
	const file = await readSaved<{ responseBody: { sha256: string; mediaType: string } }>(dir, "exchanges/pdf.json")
	expect(file.responseBody.mediaType).toBe("application/pdf")
	expect(existsSync(join(dir, "blobs", file.responseBody.sha256))).toBe(true)
	expect(JSON.stringify(file)).not.toMatch(/JVBER/)
}

/** Raw bytes in every container, a query string, a scalar, and an object on an event stream. */
async function recordsRawBodies(dir: string, journal: Journal): Promise<void> {
	await recordEach(journal, [
		{ method: "POST", requestBody: new Uint8Array([1, 2, 3]), requestId: "bin", seq: 1 },
		{ method: "POST", requestBody: new ArrayBuffer(4), requestId: "ab", seq: 2 },
		{ method: "POST", requestBody: new DataView(new ArrayBuffer(2)), requestId: "view", seq: 3 },
		{ method: "POST", requestBody: new Blob([new Uint8Array([9])]), requestId: "blob", seq: 4 },
		{ method: "POST", requestBody: new URLSearchParams({ a: "1", token: "secret" }), requestId: "qs", seq: 5 },
		{ method: "POST", requestBody: 7, requestId: "num", responseBody: undefined, seq: 6 },
		{ requestId: "sse-obj", responseBody: { already: "json" }, responseHeaders: EVENT_STREAM, seq: 7 },
	])
	const qs = await readSaved<{ requestBody: Record<string, unknown> }>(dir, "exchanges/qs.json")
	expect(qs.requestBody.token).toBe("<redacted>")
	expect(qs.requestBody.a).toBe("1")
	const bin = await readSaved<{ requestBody: { sha256: string; bytes: number } }>(dir, "exchanges/bin.json")
	expect(bin.requestBody.bytes).toBe(3)
	expect(existsSync(join(dir, "blobs", bin.requestBody.sha256))).toBe(true)
	const num = await readSaved<{ requestBody: unknown }>(dir, "exchanges/num.json")
	expect(num.requestBody).toBe(7)
}

/** A blob already on disk is reused under its digest. */
async function reusesStoredBlob(dir: string, journal: Journal): Promise<void> {
	const raw = new Uint8Array([9, 8, 7])
	const digest = createHash("sha256").update(raw).digest("hex")
	await mkdir(join(dir, "blobs"), { recursive: true })
	await writeFile(join(dir, "blobs", digest), raw)
	await recordEach(journal, [
		{
			method: "POST",
			requestBody: raw,
			requestId: "reuse-blob",
			responseBody: 3,
			responseHeaders: { "content-type": "application/octet-stream" },
			seq: 8,
		},
	])
	const reused = await readSaved<{ requestBody: { sha256: string }; responseBody: { sha256: string } }>(
		dir,
		"exchanges/reuse-blob.json",
	)
	expect(reused.requestBody.sha256).toBe(digest)
	expect(reused.responseBody.sha256).toBeDefined()
}

/** Form parts without a type, a text-only form, and a mixed-case event-stream type. */
async function recordsFormsAndOddTypes(dir: string, journal: Journal): Promise<void> {
	const emptyType = new FormData()
	emptyType.append("file", new File([new Uint8Array([1])], "a.bin"))
	const formText = new FormData()
	formText.append("note", "hi")
	await recordEach(journal, [
		{ method: "POST", requestBody: emptyType, requestId: "empty-type", seq: 9 },
		{ method: "POST", requestBody: formText, requestId: "form-text", seq: 10 },
		{
			requestId: "sse-case",
			responseBody: "hello-stream",
			responseHeaders: { "content-type": "; TEXT/EVENT-STREAM" },
			seq: 11,
		},
	])
	const empty = await readSaved<{ requestBody: { parts: Array<Record<string, unknown>> } }>(
		dir,
		"exchanges/empty-type.json",
	)
	expect(empty.requestBody.parts[0]?.mediaType).toBe("application/octet-stream")
	const sseCase = await readSaved<{ responseBody: unknown }>(dir, "exchanges/sse-case.json")
	expect(sseCase.responseBody).toBe("hello-stream")
}

/* Every body shape in one journal, ending on PDF bytes, a scalar, a huge stream, plain text and an untyped body. */
async function hashesRawBodies(): Promise<void> {
	const { dir, journal } = await journalIn()
	await recordsRawBodies(dir, journal)
	await reusesStoredBlob(dir, journal)
	await recordsFormsAndOddTypes(dir, journal)
	await recordEach(journal, [
		{
			requestId: "pdf-bytes",
			responseBody: new Uint8Array([37, 80, 68, 70]),
			responseHeaders: { "content-type": "application/pdf" },
			seq: 12,
		},
		{ requestId: "scalar-res", responseBody: 0, seq: 13 },
		{ requestId: "sse-huge", responseBody: "x".repeat(INLINE_BODY_LIMIT + 4), responseHeaders: EVENT_STREAM, seq: 14 },
		{ requestId: "plain-text", responseBody: "hello", responseHeaders: { "content-type": "text/plain" }, seq: 15 },
		{ requestId: "no-type", responseBody: { ok: true }, seq: 16 },
	])
	const pdf = await readSaved<{ responseBody: { mediaType: string } }>(dir, "exchanges/pdf-bytes.json")
	expect(pdf.responseBody.mediaType).toBe("application/pdf")
	const spilled = await readSaved<{ responseBody: { sha256: string; mediaType: string } }>(
		dir,
		"exchanges/sse-huge.json",
	)
	expect(spilled.responseBody.mediaType).toBe("text/event-stream")
	const plain = await readSaved<{ responseBody: unknown }>(dir, "exchanges/plain-text.json")
	expect(plain.responseBody).toBe("hello")
	const noType = await readSaved<{ responseBody: { ok: boolean } }>(dir, "exchanges/no-type.json")
	expect(noType.responseBody.ok).toBe(true)
}

describe("exchange journal: blobs", () => {
	it("spills oversized text and JSON to blobs/", spillsOversized)
	it("stores binary downloads as a blob pointer", storesBinaryAsPointer)
	it("hashes raw request bytes and URLSearchParams", hashesRawBodies)
})
