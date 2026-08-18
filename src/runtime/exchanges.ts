/**
 * Persist every HTTP exchange under the run dir so a green run is still inspectable.
 *
 * Layout (next to `progress.tsv`):
 *   exchanges.jsonl              one line per Exchange.seq, join key = requestId = TSV req_id
 *   exchanges/<requestId>.json   full exchange (headers + described / spilled bodies)
 *   blobs/<sha256>               content-addressed bytes (multipart, binary, oversized text)
 *
 * Redaction is on by default. This is oat's journal, not a HAR file.
 */

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describeRequestBody, type Exchange } from "./client.ts"
import { sseEvents } from "./sse.ts"

export const INLINE_BODY_LIMIT = 256 * 1024

const REDACTED = "<redacted>"

const REDACT_HEADER_NAMES = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization", "x-ia-tester-key"])

const REDACT_JSON_KEYS = new Set([
	"access_token",
	"refresh_token",
	"id_token",
	"password",
	"token",
	"secret",
	"api_key",
])

export interface ExchangeMeta {
	check?: string
	entity?: string
	phase?: string
}

export interface ExchangeJournal {
	readonly dir: string
	readonly count: number
	record(exchange: Exchange, meta?: ExchangeMeta): Promise<void>
}

export function resolveSaveExchanges(options: {
	/** CLI: true `--save-exchanges`, false `--no-save-exchanges`, omitted if neither. */
	flag?: boolean
	config?: boolean
	profile?: string
}): boolean {
	if (options.flag !== undefined) return options.flag
	if (options.config !== undefined) return options.config
	return options.profile !== "cheap"
}

export function isSecretHeaderName(name: string): boolean {
	const lower = name.toLowerCase()
	if (REDACT_HEADER_NAMES.has(lower)) return true
	return /^x-.+-(key|secret)$/i.test(lower)
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers)) {
		out[key] = isSecretHeaderName(key) ? REDACTED : value
	}
	return out
}

export function redactJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => redactJson(item))
	if (value === null || typeof value !== "object") return value
	const out: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		out[key] = REDACT_JSON_KEYS.has(key.toLowerCase()) ? REDACTED : redactJson(child)
	}
	return out
}

export function sanitizeExchangeId(requestId: string): string {
	const cleaned = requestId
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
	return cleaned === "" ? "id" : cleaned.slice(0, 180)
}

export function exchangeFileStem(requestId: string, seq: number, taken: ReadonlySet<string>): string {
	const trimmed = requestId.trim()
	const base = trimmed === "" ? `seq-${seq}` : sanitizeExchangeId(trimmed)
	if (!taken.has(base)) return base
	const dup = `${base}-${seq}`
	if (!taken.has(dup)) return dup
	let n = 2
	while (taken.has(`${dup}-${n}`)) n += 1
	return `${dup}-${n}`
}

export function primaryMediaType(mediaType: string, fallback: string): string {
	const named = mediaType
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.includes("/"))
	return named === undefined || named === "" ? fallback : named
}

export function isBinaryMediaType(mediaType: string): boolean {
	const type = primaryMediaType(mediaType, "").toLowerCase()
	if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/")) return true
	if (type === "application/octet-stream" || type === "application/pdf" || type === "application/zip") return true
	if (type === "application/vnd.ms-excel") return true
	if (type.includes("spreadsheet") || type.includes("officedocument") || type.includes("opendocument")) return true
	return false
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

function utf8Bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
	const want = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === want && value.trim() !== "") return value
	}
	return undefined
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

export function createExchangeJournal(dir: string): ExchangeJournal {
	const taken = new Set<string>()
	const writtenBlobs = new Set<string>()
	let count = 0
	let ready: Promise<void> | undefined

	const ensure = async (): Promise<void> => {
		if (ready === undefined) {
			ready = Promise.all([
				mkdir(join(dir, "exchanges"), { recursive: true }),
				mkdir(join(dir, "blobs"), { recursive: true }),
			]).then(() => undefined)
		}
		await ready
	}

	const putBlob = async (bytes: Uint8Array): Promise<{ sha256: string; bytes: number }> => {
		const sha256 = sha256Hex(bytes)
		if (!writtenBlobs.has(sha256)) {
			const path = join(dir, "blobs", sha256)
			if (!existsSync(path)) await writeFile(path, bytes)
			writtenBlobs.add(sha256)
		}
		return { bytes: bytes.byteLength, sha256 }
	}

	const spillText = async (
		text: string,
		mediaType: string,
	): Promise<string | { sha256: string; bytes: number; mediaType: string }> => {
		const bytes = utf8Bytes(text)
		if (bytes.byteLength <= INLINE_BODY_LIMIT) return text
		const blob = await putBlob(bytes)
		return { ...blob, mediaType }
	}

	const persistJson = async (value: unknown, mediaType: string): Promise<unknown> => {
		const redacted = redactJson(value)
		const text = JSON.stringify(redacted)
		if (utf8Bytes(text).byteLength <= INLINE_BODY_LIMIT) return redacted
		const blob = await putBlob(utf8Bytes(text))
		return { ...blob, mediaType }
	}

	const persistRequestBody = async (body: unknown): Promise<unknown> => {
		if (body === undefined) return undefined
		if (isFormData(body)) {
			const parts: Array<Record<string, unknown>> = []
			for (const [field, value] of body.entries()) {
				if (typeof value === "string") {
					parts.push({
						field,
						value: REDACT_JSON_KEYS.has(field.toLowerCase()) ? REDACTED : value,
					})
					continue
				}
				const bytes = new Uint8Array(await value.arrayBuffer())
				const blob = await putBlob(bytes)
				parts.push({
					bytes: blob.bytes,
					field,
					filename: value.name,
					mediaType: value.type || "application/octet-stream",
					sha256: blob.sha256,
				})
			}
			return { parts }
		}
		if (isURLSearchParams(body)) return redactJson(Object.fromEntries(body.entries()))
		const raw = await bytesOf(body)
		if (raw !== undefined) {
			const blob = await putBlob(raw)
			return { ...blob, mediaType: "application/octet-stream" }
		}
		if (typeof body === "string") return spillText(body, "text/plain")
		if (body !== null && typeof body === "object") return persistJson(body, "application/json")
		return describeRequestBody(body)
	}

	const persistResponseBody = async (exchange: Exchange): Promise<unknown> => {
		const mediaType = headerOf(exchange.responseHeaders, "content-type") ?? ""
		const body = exchange.responseBody
		if (mediaType.toLowerCase().includes("text/event-stream") && typeof body === "string") {
			const frames = sseEvents(body)
			if (frames !== null) {
				return frames.map((frame) => ({ data: redactJson(frame.data), event: frame.event }))
			}
			return spillText(body, primaryMediaType(mediaType, "text/event-stream"))
		}
		if (isBinaryMediaType(mediaType)) {
			const bytes =
				typeof body === "string" ? utf8Bytes(body) : ((await bytesOf(body)) ?? utf8Bytes(JSON.stringify(body)))
			const blob = await putBlob(bytes)
			return { ...blob, mediaType: primaryMediaType(mediaType, "application/octet-stream") }
		}
		if (body === undefined) return undefined
		if (typeof body === "string") {
			const asFrames = sseEvents(body)
			if (asFrames !== null) {
				return asFrames.map((frame) => ({ data: redactJson(frame.data), event: frame.event }))
			}
			return spillText(body, primaryMediaType(mediaType, "text/plain"))
		}
		if (body !== null && typeof body === "object") {
			return persistJson(body, primaryMediaType(mediaType, "application/json"))
		}
		return body
	}

	return {
		get count() {
			return count
		},
		get dir() {
			return dir
		},
		async record(exchange, meta = {}) {
			await ensure()
			const requestBody = await persistRequestBody(exchange.requestBody)
			const responseBody = await persistResponseBody(exchange)
			let stem = exchangeFileStem(exchange.requestId, exchange.seq, taken)
			const exchangesDir = join(dir, "exchanges")
			while (existsSync(join(exchangesDir, `${stem}.json`))) {
				taken.add(stem)
				stem = exchangeFileStem(exchange.requestId, exchange.seq, taken)
			}
			taken.add(stem)
			const rel = `exchanges/${stem}.json`
			const file = {
				at: exchange.at,
				durationMs: exchange.durationMs,
				...(exchange.fixture === undefined ? {} : { fixture: exchange.fixture }),
				method: exchange.method,
				...(exchange.operationId === undefined ? {} : { operationId: exchange.operationId }),
				requestBody,
				requestHeaders: redactHeaders(exchange.requestHeaders),
				requestId: exchange.requestId,
				responseBody,
				responseHeaders: redactHeaders(exchange.responseHeaders),
				seq: exchange.seq,
				status: exchange.status,
				url: exchange.url,
			}
			await writeFile(join(dir, rel), `${JSON.stringify(file, null, 2)}\n`)
			const line: Record<string, unknown> = {
				at: exchange.at,
				durationMs: exchange.durationMs,
				file: rel,
				method: exchange.method,
				requestBytes: exchange.requestBytes,
				requestId: exchange.requestId,
				responseBytes: exchange.responseBytes,
				seq: exchange.seq,
				status: exchange.status,
				url: exchange.url,
			}
			if (exchange.operationId !== undefined) line.operationId = exchange.operationId
			if (exchange.fixture !== undefined) line.fixture = exchange.fixture
			if (meta.check !== undefined) line.check = meta.check
			if (meta.entity !== undefined) line.entity = meta.entity
			if (meta.phase !== undefined) line.phase = meta.phase
			await appendFile(join(dir, "exchanges.jsonl"), `${JSON.stringify(line)}\n`)
			count += 1
		},
	}
}
