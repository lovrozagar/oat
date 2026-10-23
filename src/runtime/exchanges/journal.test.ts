import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { REDACTED, Redactor } from "../../security/redact.ts"
import type { Exchange } from "../exchange.ts"
import { exchangeOf } from "./__fixtures__/exchange.ts"
import { createExchangeJournal } from "./journal.ts"
import { INLINE_BODY_LIMIT } from "./media.ts"

let dir = ""

const indexLines = (): Array<Record<string, unknown>> =>
	readFileSync(join(dir, "exchanges.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
const fileOf = <T = Record<string, unknown>>(rel: string): T => JSON.parse(readFileSync(join(dir, rel), "utf8")) as T

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "oat-journal-"))
})

afterEach(() => {
	rmSync(dir, { force: true, recursive: true })
})

describe("createExchangeJournal, one exchange", () => {
	it("queues the exchange's file and index line until flushed", async () => {
		const journal = createExchangeJournal(dir, new Redactor())
		expect([journal.dir, journal.count]).toEqual([dir, 0])
		await journal.flush()
		expect(existsSync(join(dir, "exchanges.jsonl"))).toBe(false)
		await journal.record(exchangeOf())
		expect([journal.count, existsSync(join(dir, "exchanges.jsonl"))]).toEqual([1, false])
		await journal.flush()
		const [line] = indexLines()
		expect(line).toEqual({
			at: 1_800_000_000_000,
			durationMs: 12,
			file: "exchanges/req-1.json",
			method: "GET",
			requestBytes: 40,
			requestId: "req-1",
			responseBytes: 80,
			seq: 1,
			status: 200,
			url: "http://h.test/v1/items",
		})
		expect(Object.keys(fileOf("exchanges/req-1.json"))).toEqual([
			"at",
			"durationMs",
			"method",
			"requestHeaders",
			"requestId",
			"responseBody",
			"responseHeaders",
			"seq",
			"status",
			"url",
		])
	})
})

describe("createExchangeJournal, a full exchange", () => {
	it("writes everything an exchange carries, redacted, and the context it was made in", async () => {
		const redactor = new Redactor()
		redactor.registerSecret("s3cret-value")
		const journal = createExchangeJournal(dir, redactor)
		const exchange = exchangeOf({
			finalUrl: "http://h.test/v1/items/2",
			fixture: "a.png",
			operationId: "items.list",
			redirects: [
				{ responseHeaders: { "set-cookie": "sid=1" }, status: 303, url: "http://h.test/v1/go?k=s3cret-value" },
			],
			requestBody: { password: "p" },
			requestHeaders: { authorization: "Bearer t" },
			url: "http://h.test/v1/items?k=s3cret-value",
		})
		await journal.record(exchange, { check: "list.pages", entity: "items", phase: "test" })
		await journal.flush()
		const [line] = indexLines()
		expect(line).toMatchObject({
			check: "list.pages",
			entity: "items",
			finalUrl: "http://h.test/v1/items/2",
			fixture: "a.png",
			operationId: "items.list",
			phase: "test",
			redirects: 1,
		})
		expect(String(line?.url)).not.toContain("s3cret-value")
		const file = fileOf("exchanges/req-1.json")
		expect(Object.keys(file)).toEqual([
			"at",
			"durationMs",
			"fixture",
			"finalUrl",
			"method",
			"operationId",
			"requestBody",
			"requestHeaders",
			"requestId",
			"responseBody",
			"responseHeaders",
			"redirects",
			"seq",
			"status",
			"url",
		])
		expect([file.requestBody, file.requestHeaders]).toEqual([
			{ password: REDACTED },
			{ authorization: `Bearer ${REDACTED}` },
		])
		expect(JSON.stringify(file.redirects)).not.toContain("s3cret-value")
	})
})

describe("createExchangeJournal, many exchanges", () => {
	it("names each file apart, around files an earlier journal left", async () => {
		mkdirSync(join(dir, "exchanges"), { recursive: true })
		writeFileSync(join(dir, "exchanges", "req-1.json"), "{}")
		writeFileSync(join(dir, "exchanges", "req-1-2.json"), "{}")
		const journal = createExchangeJournal(dir, new Redactor())
		await journal.record(exchangeOf({ seq: 2 }))
		await journal.record(exchangeOf({ requestId: "", seq: 3 }))
		await journal.record(exchangeOf({ seq: 4 }))
		await journal.flush()
		expect(indexLines().map((line) => line.file)).toEqual([
			"exchanges/req-1-2-2.json",
			"exchanges/seq-3.json",
			"exchanges/req-1-4.json",
		])
	})

	it("appends the index in batches of 64 without being asked", async () => {
		const journal = createExchangeJournal(dir, new Redactor())
		for (let seq = 1; seq <= 64; seq++) await journal.record(exchangeOf({ requestId: `r${seq}`, seq }))
		expect(indexLines()).toHaveLength(64)
		await journal.record(exchangeOf({ requestId: "r65", seq: 65 }))
		expect([indexLines().length, journal.count]).toEqual([64, 65])
		await journal.flush()
		expect(indexLines()).toHaveLength(65)
	})
})

type Journal = ReturnType<typeof createExchangeJournal>

/** A row as the journal is handed it: no headers, no body, unless a test sets them. */
const row = (overrides: Partial<Exchange>): Exchange =>
	exchangeOf({ requestHeaders: {}, responseBody: null, responseHeaders: {}, ...overrides })

/** Records each row and flushes after each, in order. */
async function recordEach(journal: Journal, rows: readonly Partial<Exchange>[]): Promise<void> {
	for (const each of rows) {
		await journal.record(row(each))
		await journal.flush()
	}
}

/** A journal over this test's scratch folder. */
const journalIn = (): Journal => createExchangeJournal(dir, new Redactor())

const EVENT_STREAM = { "content-type": "text/event-stream" }

async function storesParsedFrames(): Promise<void> {
	const journal = journalIn()
	await recordEach(journal, [
		{
			requestId: "sse-frames",
			responseBody: [{ data: { access_token: "nope", n: 1 }, event: "batch" }],
			responseHeaders: EVENT_STREAM,
			seq: 1,
		},
	])
	const file = fileOf<{ responseBody: unknown }>("exchanges/sse-frames.json")
	expect(file.responseBody).toEqual([{ data: { access_token: "<redacted>", n: 1 }, event: "batch" }])
}

async function storesSseAsFrames(): Promise<void> {
	const journal = journalIn()
	await recordEach(journal, [
		{
			requestId: "sse-1",
			responseBody: 'event: batch\ndata: {"access_token":"nope","n":1}\n\n',
			responseHeaders: EVENT_STREAM,
			seq: 1,
		},
	])
	const file = fileOf<{ responseBody: Array<{ event: string; data: Record<string, unknown> }> }>("exchanges/sse-1.json")
	expect(file.responseBody).toEqual([{ data: { access_token: "<redacted>", n: 1 }, event: "batch" }])
	expect(JSON.stringify(file)).not.toContain("nope")
}

async function keepsUnframedStream(): Promise<void> {
	const journal = journalIn()
	await recordEach(journal, [
		{ requestId: "sse-raw", responseBody: "not a frame", responseHeaders: EVENT_STREAM, seq: 1 },
	])
	const file = fileOf<{ responseBody: unknown }>("exchanges/sse-raw.json")
	expect(file.responseBody).toBe("not a frame")
}

async function guessesFramesWithoutHeader(): Promise<void> {
	const journal = journalIn()
	await recordEach(journal, [
		{
			requestId: "sse-guess",
			responseBody: 'data: {"ok":true}\n\n',
			responseHeaders: { "content-type": "text/plain" },
			seq: 1,
		},
	])
	const file = fileOf<{ responseBody: unknown }>("exchanges/sse-guess.json")
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
	const journal = journalIn()
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
	const file = fileOf<{ requestBody: BlobRef; responseBody: BlobRef }>("exchanges/big-text.json")
	expect(file.requestBody.bytes).toBeGreaterThan(INLINE_BODY_LIMIT)
	expect(file.requestBody.mediaType).toBe("text/plain")
	expect(file.responseBody.mediaType).toBe("application/json")
	expect(existsSync(join(dir, "blobs", file.requestBody.sha256))).toBe(true)
	expect(existsSync(join(dir, "blobs", file.responseBody.sha256))).toBe(true)
}

async function storesBinaryAsPointer(): Promise<void> {
	const journal = journalIn()
	const pdf = { "content-type": "application/pdf" }
	await recordEach(journal, [
		{ requestId: "pdf", responseBody: "%PDF-1.4 fake", responseHeaders: pdf, seq: 1 },
		{ requestId: "pdf-obj", responseBody: { note: "not-bytes" }, responseHeaders: pdf, seq: 2 },
	])
	const file = fileOf<{ responseBody: { sha256: string; mediaType: string } }>("exchanges/pdf.json")
	expect(file.responseBody.mediaType).toBe("application/pdf")
	expect(existsSync(join(dir, "blobs", file.responseBody.sha256))).toBe(true)
	expect(JSON.stringify(file)).not.toMatch(/JVBER/)
}

/** Raw bytes in every container, a query string, a scalar, and an object on an event stream. */
async function recordsRawBodies(journal: Journal): Promise<void> {
	await recordEach(journal, [
		{ method: "POST", requestBody: new Uint8Array([1, 2, 3]), requestId: "bin", seq: 1 },
		{ method: "POST", requestBody: new ArrayBuffer(4), requestId: "ab", seq: 2 },
		{ method: "POST", requestBody: new DataView(new ArrayBuffer(2)), requestId: "view", seq: 3 },
		{ method: "POST", requestBody: new Blob([new Uint8Array([9])]), requestId: "blob", seq: 4 },
		{ method: "POST", requestBody: new URLSearchParams({ a: "1", token: "secret" }), requestId: "qs", seq: 5 },
		{ method: "POST", requestBody: 7, requestId: "num", responseBody: undefined, seq: 6 },
		{ requestId: "sse-obj", responseBody: { already: "json" }, responseHeaders: EVENT_STREAM, seq: 7 },
	])
	const qs = fileOf<{ requestBody: Record<string, unknown> }>("exchanges/qs.json")
	expect(qs.requestBody.token).toBe("<redacted>")
	expect(qs.requestBody.a).toBe("1")
	const bin = fileOf<{ requestBody: { sha256: string; bytes: number } }>("exchanges/bin.json")
	expect(bin.requestBody.bytes).toBe(3)
	expect(existsSync(join(dir, "blobs", bin.requestBody.sha256))).toBe(true)
	const num = fileOf<{ requestBody: unknown }>("exchanges/num.json")
	expect(num.requestBody).toBe(7)
}

/** A blob already on disk is reused under its digest. */
async function reusesStoredBlob(journal: Journal): Promise<void> {
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
	const reused = fileOf<{ requestBody: { sha256: string }; responseBody: { sha256: string } }>(
		"exchanges/reuse-blob.json",
	)
	expect(reused.requestBody.sha256).toBe(digest)
	expect(reused.responseBody.sha256).toBeDefined()
}

/** Form parts without a type, a text-only form, and a mixed-case event-stream type. */
async function recordsFormsAndOddTypes(journal: Journal): Promise<void> {
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
	const empty = fileOf<{ requestBody: { parts: Array<Record<string, unknown>> } }>("exchanges/empty-type.json")
	expect(empty.requestBody.parts[0]?.mediaType).toBe("application/octet-stream")
	const sseCase = fileOf<{ responseBody: unknown }>("exchanges/sse-case.json")
	expect(sseCase.responseBody).toBe("hello-stream")
}

/* Every body shape in one journal, ending on PDF bytes, a scalar, a huge stream, plain text and an untyped body. */
async function hashesRawBodies(): Promise<void> {
	const journal = journalIn()
	await recordsRawBodies(journal)
	await reusesStoredBlob(journal)
	await recordsFormsAndOddTypes(journal)
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
	const pdf = fileOf<{ responseBody: { mediaType: string } }>("exchanges/pdf-bytes.json")
	expect(pdf.responseBody.mediaType).toBe("application/pdf")
	const spilled = fileOf<{ responseBody: { sha256: string; mediaType: string } }>("exchanges/sse-huge.json")
	expect(spilled.responseBody.mediaType).toBe("text/event-stream")
	const plain = fileOf<{ responseBody: unknown }>("exchanges/plain-text.json")
	expect(plain.responseBody).toBe("hello")
	const noType = fileOf<{ responseBody: { ok: boolean } }>("exchanges/no-type.json")
	expect(noType.responseBody.ok).toBe(true)
}

describe("exchange journal: blobs", () => {
	it("spills oversized text and JSON to blobs/", spillsOversized)
	it("stores binary downloads as a blob pointer", storesBinaryAsPointer)
	it("hashes raw request bytes and URLSearchParams", hashesRawBodies)
})
