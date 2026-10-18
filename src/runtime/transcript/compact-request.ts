/** A request body as the transcript keeps it once the request is over. */

import { type FormPart, isBodyRef, isFormData, isFormSnapshot, isURLSearchParams } from "../exchange.ts"
import { bytesOf, sha256Hex, utf8Encode } from "../exchanges/bytes.ts"
import { formFieldPart, formFilePart } from "../exchanges/form-parts.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"
import type { Redactor } from "../../security/redact.ts"
import { bodyRef } from "./live.ts"
import type { BodyDigest, SentBody } from "./types.ts"

/** A key sent more than once is how a form sends an array; keep every value. */
function searchParamFields(body: URLSearchParams): Record<string, string | string[]> {
	const fields: Record<string, string | string[]> = {}
	for (const [key, value] of body.entries()) {
		const prior = fields[key]
		fields[key] = prior === undefined ? value : [...[prior].flat(), value]
	}
	return fields
}

/** A text or JSON body: inline while small, by reference once past the limit. */
function compactSentValue(body: unknown, knownBytes: number | undefined, digest: BodyDigest | undefined): unknown {
	/* Hashed when it was sent, from the text that went out (a string or JSON); nothing to
	 * serialize again. */
	if (digest !== undefined) {
		return {
			bytes: digest.bytes,
			mediaType: typeof body === "string" ? "text/plain" : "application/json",
			sha256: digest.sha256,
		}
	}
	if (typeof body === "string") {
		const bytes = utf8Encode(body)
		return bytes.byteLength <= INLINE_BODY_LIMIT ? body : bodyRef(bytes, "text/plain")
	}
	if (body !== null && typeof body === "object") {
		/* The size it went out at is already known; serializing again only to measure is waste. */
		if (knownBytes !== undefined && knownBytes <= INLINE_BODY_LIMIT) return body
		const bytes = utf8Encode(JSON.stringify(body))
		return bytes.byteLength <= INLINE_BODY_LIMIT ? body : bodyRef(bytes, "application/json")
	}
	return body
}

export async function compactRequestBody(body: unknown, redactor: Redactor, sent: SentBody = {}): Promise<unknown> {
	const { bytes: knownBytes, digest } = sent
	if (body === undefined) return undefined
	if (isFormSnapshot(body) || isBodyRef(body)) return body
	if (isFormData(body)) {
		const parts: FormPart[] = []
		for (const [field, value] of body.entries()) {
			if (typeof value === "string") {
				parts.push(formFieldPart(field, value))
				continue
			}
			const bytes = new Uint8Array(await value.arrayBuffer())
			parts.push(formFilePart(field, value, { bytes: bytes.byteLength, sha256: sha256Hex(bytes) }))
		}
		return { parts }
	}
	if (isURLSearchParams(body)) return redactor.json(searchParamFields(body))
	const raw = await bytesOf(body)
	if (raw !== undefined) return bodyRef(raw, "application/octet-stream")
	return compactSentValue(body, knownBytes, digest)
}
