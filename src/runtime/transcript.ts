/**
 * In-memory exchange bodies: descriptors, not live FormData / Blobs / multi-MiB strings.
 *
 * The journal already spills those to `blobs/<sha256>` on disk. The transcript kept on
 * `Client` must not retain a second copy for the rest of the run — findings cite hops by
 * method, URL, status, headers, sizes, and content-addressed body refs.
 */

import { createHash } from "node:crypto"
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

export async function compactRequestBody(body: unknown): Promise<unknown> {
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
	if (isURLSearchParams(body)) return redactJson(Object.fromEntries(body.entries()))
	const raw = await bytesOf(body)
	if (raw !== undefined) return bodyRef(raw, "application/octet-stream")
	if (typeof body === "string") {
		const bytes = utf8Bytes(body)
		return bytes.byteLength <= INLINE_BODY_LIMIT ? body : bodyRef(bytes, "text/plain")
	}
	if (body !== null && typeof body === "object") {
		const bytes = utf8Bytes(JSON.stringify(body))
		return bytes.byteLength <= INLINE_BODY_LIMIT ? body : bodyRef(bytes, "application/json")
	}
	return body
}

export async function compactResponseBody(body: unknown, responseHeaders: Record<string, string>): Promise<unknown> {
	if (body === undefined) return undefined
	if (isBodyRef(body) || isFormSnapshot(body)) return body
	const mediaType = headerOf(responseHeaders, "content-type") ?? ""
	const sse = mediaType.toLowerCase().includes("text/event-stream")
	if (Array.isArray(body)) {
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
		const frames = sseEvents(body)
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
		const bytes = utf8Bytes(JSON.stringify(body))
		return bytes.byteLength <= INLINE_BODY_LIMIT
			? body
			: bodyRef(bytes, primaryMediaType(mediaType, "application/json"))
	}
	return body
}

/** Drop live request/response payloads on an exchange already pushed to the transcript. */
export async function releaseTranscriptBodies(exchange: Exchange): Promise<void> {
	exchange.requestBody = await compactRequestBody(exchange.requestBody)
	exchange.responseBody = await compactResponseBody(exchange.responseBody, exchange.responseHeaders)
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
	const text = await response.text()
	const bodyBytes = utf8ByteLength(text)
	if (text === "") return { bodyBytes: 0, parsed: null }
	try {
		return { bodyBytes, parsed: JSON.parse(text) as unknown }
	} catch {
		return { bodyBytes, parsed: text }
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

function headerOf(headers: Record<string, string>, name: string): string | undefined {
	const want = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === want && value.trim() !== "") return value
	}
	return undefined
}

export type { SseFrame }
