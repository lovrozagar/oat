/**
 * In-memory exchange bodies: descriptors, not live FormData / Blobs / multi-MiB strings.
 *
 * The journal already spills those to `blobs/<sha256>` on disk. The transcript kept on
 * `Client` must not retain a second copy for the rest of the run — findings cite hops by
 * method, URL, status, headers, sizes, and content-addressed body refs.
 */

import { presentHeader } from "./headers.ts"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Exchange } from "./client.ts"
import {
	INLINE_BODY_LIMIT,
	isBinaryMediaType,
	isSecretJsonKey,
	primaryMediaType,
	redactJson,
	REDACTED,
} from "./exchanges.ts"
import { parseSse, SseParser, sseEvents, sseFramesOf, type SseFrame } from "./sse.ts"

export interface BodyRef {
	sha256: string
	bytes: number
	mediaType: string
}

export type FormPart =
	| { field: string; value: string }
	| { field: string; filename: string; mediaType: string; bytes: number; sha256: string }

export interface FormSnapshot {
	parts: FormPart[]
}

export function isBodyRef(value: unknown): value is BodyRef {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false
	const rec = value as Record<string, unknown>
	if (typeof rec.sha256 !== "string" || typeof rec.bytes !== "number" || typeof rec.mediaType !== "string") {
		return false
	}
	for (const key of Object.keys(rec)) {
		if (key !== "sha256" && key !== "bytes" && key !== "mediaType") return false
	}
	return true
}

export function isFormSnapshot(value: unknown): value is FormSnapshot {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false
	const rec = value as { parts?: unknown }
	if (!Array.isArray(rec.parts)) return false
	return Object.keys(rec).every((key) => key === "parts")
}

/** True when `value` is a live multipart/binary object or an oversized string still on the heap. */
export function holdsLiveBody(value: unknown): boolean {
	if (typeof FormData !== "undefined" && value instanceof FormData) return true
	if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return true
	if (typeof Blob !== "undefined" && value instanceof Blob) return true
	if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true
	if (ArrayBuffer.isView(value)) return true
	if (typeof value === "string" && utf8ByteLength(value) > INLINE_BODY_LIMIT) return true
	return false
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

export function bodyRef(bytes: Uint8Array, mediaType: string): BodyRef {
	return { bytes: bytes.byteLength, mediaType, sha256: sha256Hex(bytes) }
}

export async function compactRequestBody(body: unknown, knownBytes?: number): Promise<unknown> {
	if (body === undefined) return undefined
	if (isFormSnapshot(body) || isBodyRef(body)) return body
	if (isFormData(body)) {
		const parts: FormPart[] = []
		for (const [field, value] of body.entries()) {
			if (typeof value === "string") {
				parts.push({ field, value: isSecretJsonKey(field) ? REDACTED : value })
				continue
			}
			const bytes = new Uint8Array(await value.arrayBuffer())
			parts.push({
				bytes: bytes.byteLength,
				field,
				filename: value.name,
				mediaType: value.type || "application/octet-stream",
				sha256: sha256Hex(bytes),
			})
		}
		return { parts }
	}
	if (isURLSearchParams(body)) {
		/* A key sent more than once is how a form sends an array; keep every value. */
		const fields: Record<string, string | string[]> = {}
		for (const [key, value] of body.entries()) {
			const prior = fields[key]
			fields[key] = prior === undefined ? value : [...[prior].flat(), value]
		}
		return redactJson(fields)
	}
	const raw = await bytesOf(body)
	if (raw !== undefined) return bodyRef(raw, "application/octet-stream")
	if (typeof body === "string") {
		const bytes = utf8Bytes(body)
		return bytes.byteLength <= INLINE_BODY_LIMIT ? body : bodyRef(bytes, "text/plain")
	}
	if (body !== null && typeof body === "object") {
		/* The size it went out at is already known; serializing again only to measure is waste. */
		if (knownBytes !== undefined && knownBytes <= INLINE_BODY_LIMIT) return body
		const bytes = utf8Bytes(JSON.stringify(body))
		return bytes.byteLength <= INLINE_BODY_LIMIT ? body : bodyRef(bytes, "application/json")
	}
	return body
}

export async function compactResponseBody(
	body: unknown,
	responseHeaders: Record<string, string>,
	knownBytes?: number,
): Promise<unknown> {
	if (body === undefined) return undefined
	if (isBodyRef(body) || isFormSnapshot(body)) return body
	const mediaType = presentHeader(responseHeaders, "content-type") ?? ""
	const sse = mediaType.toLowerCase().includes("text/event-stream")
	/* Frames only under text/event-stream: a JSON array of strings, or a string that happens to
	 * start with "data:", is just that. */
	if (sse && Array.isArray(body)) {
		const frames = sseEvents(body)
		if (frames !== null) {
			const compact = sseFramesOf(frames)
			const bytes = utf8Bytes(JSON.stringify(compact))
			return bytes.byteLength <= INLINE_BODY_LIMIT
				? compact
				: bodyRef(bytes, primaryMediaType(mediaType, "text/event-stream"))
		}
	}
	if (typeof body === "string") {
		const frames = sse ? sseEvents(body) : null
		if (frames !== null) {
			const compact = sseFramesOf(frames)
			const bytes = utf8Bytes(JSON.stringify(compact))
			return bytes.byteLength <= INLINE_BODY_LIMIT
				? compact
				: bodyRef(bytes, primaryMediaType(mediaType, "text/event-stream"))
		}
		const bytes = utf8Bytes(body)
		if (sse && bytes.byteLength <= INLINE_BODY_LIMIT) return body
		if (!sse && !isBinaryMediaType(mediaType) && bytes.byteLength <= INLINE_BODY_LIMIT) return body
		return bodyRef(bytes, primaryMediaType(mediaType, sse ? "text/event-stream" : "text/plain"))
	}
	const raw = await bytesOf(body)
	if (raw !== undefined) {
		return bodyRef(raw, primaryMediaType(mediaType, "application/octet-stream"))
	}
	if (body !== null && typeof body === "object") {
		if (knownBytes !== undefined && knownBytes <= INLINE_BODY_LIMIT) return body
		const bytes = utf8Bytes(JSON.stringify(body))
		return bytes.byteLength <= INLINE_BODY_LIMIT
			? body
			: bodyRef(bytes, primaryMediaType(mediaType, "application/json"))
	}
	return body
}

/** Drop live request/response payloads on an exchange already pushed to the transcript. */
export async function releaseTranscriptBodies(exchange: Exchange): Promise<void> {
	exchange.requestBody = await compactRequestBody(exchange.requestBody, exchange.requestBytes)
	exchange.responseBody = await compactResponseBody(
		exchange.responseBody,
		exchange.responseHeaders,
		exchange.responseBytes,
	)
}

export interface ResponsePayload {
	parsed: unknown
	bodyBytes: number
}

/**
 * Read a fetch Response. `text/event-stream` is parsed incrementally so the raw concatenation
 * never lands on the transcript. Other bodies are fully read (one-request peak), then the
 * caller compactes after the journal has spilled.
 */
export async function readResponsePayload(response: Response): Promise<ResponsePayload> {
	const contentType = response.headers.get("content-type") ?? ""
	if (contentType.toLowerCase().includes("text/event-stream")) {
		return readSsePayload(response)
	}
	/* Bytes once: their count is the size on the wire, whatever the encoding. Only text is
	 * decoded, and by the charset it declares — a Latin-1 page read as UTF-8 is a different page. */
	const bytes = new Uint8Array(await response.arrayBuffer())
	const bodyBytes = bytes.byteLength
	if (bodyBytes === 0) return { bodyBytes: 0, parsed: null }
	if (isBinaryMediaType(contentType)) return { bodyBytes, parsed: bytes }
	const text = decodeText(bytes, contentType)
	try {
		return { bodyBytes, parsed: JSON.parse(text) as unknown }
	} catch {
		return { bodyBytes, parsed: text }
	}
}

function decodeText(bytes: Uint8Array, contentType: string): string {
	const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes)
	} catch {
		/* An unknown label is the server's mistake; UTF-8 is the only sensible reading left. */
		return new TextDecoder("utf-8").decode(bytes)
	}
}

async function readSsePayload(response: Response): Promise<ResponsePayload> {
	if (response.body === null) {
		return parseSseText(await response.text())
	}
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	const parser = new SseParser()
	const hash = createHash("sha256")
	let total = 0
	const rawChunks: string[] = []
	let keepRaw = true
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			const chunk = value ?? new Uint8Array()
			total += chunk.byteLength
			hash.update(chunk)
			const piece = decoder.decode(chunk, { stream: true })
			parser.push(piece)
			if (keepRaw) {
				rawChunks.push(piece)
				if (total > INLINE_BODY_LIMIT) {
					keepRaw = false
					rawChunks.length = 0
				}
			}
		}
		const tail = decoder.decode()
		if (tail !== "") {
			parser.push(tail)
			if (keepRaw) rawChunks.push(tail)
		}
	} finally {
		reader.releaseLock()
	}
	const events = parser.finish()
	if (events.length > 0) {
		return { bodyBytes: total, parsed: sseFramesOf(events) }
	}
	if (keepRaw) return parseSseText(rawChunks.join(""), total)
	return {
		bodyBytes: total,
		parsed: { bytes: total, mediaType: "text/event-stream", sha256: hash.digest("hex") },
	}
}

function parseSseText(text: string, bodyBytes = utf8ByteLength(text)): ResponsePayload {
	const events = parseSse(text)
	if (events.length > 0) return { bodyBytes, parsed: sseFramesOf(events) }
	if (bodyBytes > INLINE_BODY_LIMIT) return { bodyBytes, parsed: bodyRef(utf8Bytes(text), "text/event-stream") }
	return { bodyBytes, parsed: text }
}

async function bytesOf(value: unknown): Promise<Uint8Array | undefined> {
	if (value instanceof Uint8Array) return value
	if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value)
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
	if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
	return undefined
}

function isFormData(body: unknown): body is FormData {
	return typeof FormData !== "undefined" && body instanceof FormData
}

function isURLSearchParams(body: unknown): body is URLSearchParams {
	return typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams
}

function utf8Bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function utf8ByteLength(text: string): number {
	return text === "" ? 0 : utf8Bytes(text).byteLength
}

export type { SseFrame }

/** Bytes of transcript bodies kept in memory before the oldest move to disk. */
export const TRANSCRIPT_BODY_BUDGET = 32 * 1024 * 1024

/** Where a body went when it moved out of memory. */
export interface SpooledBody {
	spooled: number
}

export function isSpooledBody(value: unknown): value is SpooledBody {
	return value !== null && typeof value === "object" && typeof (value as SpooledBody).spooled === "number"
}

/**
 * Transcript bodies past a memory budget, on disk.
 *
 * The transcript keeps every exchange — checks judge it after the fact — but not every body in
 * memory: a run that read a few hundred large pages would otherwise hold them all. Bodies are
 * kept newest first up to the budget; older ones are written to a private directory, exactly as
 * they were (this is not the journal, which redacts), and read back on request.
 */
export class BodySpool {
	private readonly kept: Array<{ exchange: Exchange; bytes: number }> = []
	private held = 0
	private dir: string | undefined

	constructor(private readonly budget = TRANSCRIPT_BODY_BUDGET) {}

	async keep(exchange: Exchange): Promise<void> {
		const bytes = exchange.requestBytes + exchange.responseBytes
		this.kept.push({ bytes, exchange })
		this.held += bytes
		while (this.held > this.budget && this.kept.length > 1) {
			/* More than one is kept, so there is an oldest. */
			const oldest = this.kept.shift() as { exchange: Exchange; bytes: number }
			this.held -= oldest.bytes
			await this.write(oldest.exchange)
		}
	}

	async hydrate(exchange: Exchange): Promise<Exchange> {
		if (!isSpooledBody(exchange.responseBody) && !isSpooledBody(exchange.requestBody)) return exchange
		const seq = (isSpooledBody(exchange.responseBody) ? exchange.responseBody : exchange.requestBody) as SpooledBody
		/* A marker exists only once a write has made the directory. */
		const saved = JSON.parse(await readFile(join(this.dir as string, `${seq.spooled}.json`), "utf8")) as {
			requestBody?: unknown
			responseBody?: unknown
		}
		return { ...exchange, requestBody: saved.requestBody, responseBody: saved.responseBody }
	}

	async dispose(): Promise<void> {
		if (this.dir === undefined) return
		await rm(this.dir, { force: true, recursive: true })
		this.dir = undefined
	}

	private async write(exchange: Exchange): Promise<void> {
		this.dir ??= await mkdtemp(join(tmpdir(), "oat-transcript-"))
		const body = { requestBody: exchange.requestBody, responseBody: exchange.responseBody }
		await writeFile(join(this.dir, `${exchange.seq}.json`), JSON.stringify(body))
		const marker: SpooledBody = { spooled: exchange.seq }
		exchange.requestBody = exchange.requestBody === undefined ? undefined : marker
		exchange.responseBody = exchange.responseBody === undefined ? undefined : marker
	}
}
