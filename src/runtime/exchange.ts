/*
 * One request and its answer as oat records it, and how its body is described: a live FormData,
 * a stored reference, a form snapshot or raw bytes. Every module that reads an exchange reads this
 * one, so the client, the transcript and the journal share a shape without importing each other.
 */

import { isRaw } from "../config/types/raw.ts"
import type { NetworkKind } from "../errors/network.ts"
import type { RedirectHop } from "./cookies/redirect.ts"

export interface Exchange {
	seq: number
	method: string
	url: string
	requestHeaders: Record<string, string>
	requestBody: unknown
	status: number
	responseHeaders: Record<string, string>
	responseBody: unknown
	durationMs: number
	/** Wall clock when the response finished, unix ms. */
	at: number
	/** Reconstructed HTTP/1.1 request size: start line, headers, body. */
	requestBytes: number
	/** Reconstructed HTTP/1.1 response size: start line, headers, body. */
	responseBytes: number
	/**
	 * `x-request-id` / `request-id` / `x-correlation-id` / `correlation-id`.
	 * Response header wins; otherwise what oat sent. Empty when neither side passed one.
	 */
	requestId: string
	/** Rate-limit category this request was paced against, when one matched. */
	rateLimitCategory?: string
	/** Where that category came from — a `spec.*` finding only ever cites a `"tag"` rejection. */
	rateLimitSource?: "tag" | "config" | "implicit"
	/** Whether the bucket had a token without waiting — oat believes it was under its own pace. */
	rateLimitHadRoom?: boolean
	/** Size and hash of a large request body as sent; what a stored reference names. */
	requestDigest?: { bytes: number; sha256: string }
	/** Size and hash of a large response body as received; what a stored reference names. */
	responseDigest?: { bytes: number; sha256: string }
	/** Named operation, when the caller passed one. */
	operationId?: string
	/** `uploads.each` filename, when this request is one cell of that matrix. */
	fixture?: string
	/** Set when `fetch` threw — there was no HTTP status. */
	network?: { kind: NetworkKind; attempt: number; message: string }
	/**
	 * Intermediate 3xx hops when this request followed redirects with a cookie jar.
	 * The exchange itself is the original URL + the final status/headers/body.
	 */
	redirects?: RedirectHop[]
	/** Landing URL when a followed redirect chain ended somewhere other than `url`. */
	finalUrl?: string
	/** Cookie jar after this hop (this response + followed hops). */
	cookies?: Record<string, string>
	/** The documented path template this request resolved to, e.g. `/v1/tables/{table_id}`. */
	template?: string
	/** The value each of the template's path parameters took in this request, URI-decoded. */
	pathParams?: Record<string, string>
	/** The principal whose credential the request carried, when one did. */
	principal?: string
	/** The security schemes whose credentials the request carried, in the order its alternative names them. */
	schemes?: string[]
	/** Set when the credential was forged on purpose: a probe that expects the backend to refuse it. */
	forged?: true
	/**
	 * Sent as a probe: meant to be refused (`probe: true`). A forged credential is a probe too, and says
	 * so in `forged`. A dedicated credential alone is not: the contract floor's calls with one are
	 * ordinary traffic. A probe's answer is the security checks' to judge.
	 */
	probe?: true
	/** Why oat sent it — see `Purpose`. */
	purpose?: Purpose
	/** Sent by the credential store's own ports (a login, a mint, a revoke): what it issues is the store's. */
	issuedBy?: "credentials"
	/** The check that issued it, when a check did. */
	check?: string
	/** The entity under test when it was issued. */
	subject?: string
	/**
	 * Set when this response was answered again: a 401 refreshed and retried, or a 429 waited out.
	 * Only the final answer is the backend's verdict on the request.
	 */
	superseded?: true
	/**
	 * How the response body held to the schema its operation documents for the status, taken when
	 * it was captured: set when the transcript keeps the body only by reference, as no later reader
	 * could validate it. A body kept whole is validated by the check that reads it.
	 */
	schemaVerdict?: SchemaVerdict
}

/** A body's validation against its documented schema: the errors, or why the schema could not compile. */
export interface SchemaVerdict {
	errors: string[]
	unchecked?: string
}

/**
 * Why an exchange happened. Normal traffic — seeding, a check's assertions, auth, teardown — is
 * what the document has to describe. A deliberate negative probe is oat sending something it
 * expects to be refused, and what a backend answers it with is judged separately.
 */
export type Purpose = "seed" | "assertion" | "probe" | "auth" | "teardown"

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
	if (!isRaw<BodyRef>(value)) return false
	const rec = value
	if (typeof rec.sha256 !== "string" || typeof rec.bytes !== "number" || typeof rec.mediaType !== "string") {
		return false
	}
	for (const key of Object.keys(rec)) {
		if (key !== "sha256" && key !== "bytes" && key !== "mediaType") return false
	}
	return true
}

export function isFormSnapshot(value: unknown): value is FormSnapshot {
	if (!isRaw<FormSnapshot>(value) || !Array.isArray(value.parts)) return false
	return Object.keys(value).every((key) => key === "parts")
}

export function isFormData(body: unknown): body is FormData {
	return body instanceof FormData
}

export function isURLSearchParams(body: unknown): body is URLSearchParams {
	return body instanceof URLSearchParams
}

export function isRawBytes(body: unknown): body is ArrayBuffer | ArrayBufferView | Blob {
	return body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob
}

export function bodyByteLength(body: unknown): number {
	if (typeof body === "string") return utf8Bytes(body)
	if (isFormData(body)) return formDataBytes(body)
	if (isURLSearchParams(body)) return utf8Bytes(body.toString())
	if (body instanceof Blob) return body.size
	if (body instanceof ArrayBuffer) return body.byteLength
	if (ArrayBuffer.isView(body)) return body.byteLength
	return 0
}

export function formDataBytes(form: FormData): number {
	let total = 0
	for (const [name, value] of form.entries()) {
		total += utf8Bytes(name) + 80
		if (typeof value === "string") total += utf8Bytes(value)
		else total += value.size + utf8Bytes(value.name)
	}
	return total
}

export function utf8Bytes(text: string | undefined): number {
	/* Counted, not encoded: a copy of every body just to measure it is the cost to avoid. */
	return text === undefined || text === "" ? 0 : Buffer.byteLength(text, "utf8")
}

/** Plain snapshot of a request body for reports — FormData is not JSON. */
export function describeRequestBody(body: unknown): unknown {
	if (body === undefined) return undefined
	if (isFormData(body)) {
		const parts: Record<string, unknown> = {}
		for (const [name, value] of body.entries()) {
			if (typeof value === "string") parts[name] = value
			else parts[name] = { filename: value.name, mediaType: value.type, bytes: value.size }
		}
		return parts
	}
	if (isFormSnapshot(body)) {
		const parts: Record<string, unknown> = {}
		for (const part of body.parts) {
			if ("value" in part) parts[part.field] = part.value
			else parts[part.field] = { bytes: part.bytes, filename: part.filename, mediaType: part.mediaType }
		}
		return parts
	}
	if (isURLSearchParams(body)) return body.toString()
	if (isRawBytes(body)) return { bytes: bodyByteLength(body) }
	if (isBodyRef(body)) return { bytes: body.bytes, mediaType: body.mediaType, sha256: body.sha256 }
	return body
}
