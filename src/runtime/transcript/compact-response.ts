/** A response body as the transcript keeps it once the request is over. */

import { type BodyRef, isBodyRef, isFormSnapshot } from "../exchange.ts"
import { bytesOf, utf8Encode } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT, isBinaryMediaType, primaryMediaType } from "../exchanges/media.ts"
import { presentHeader } from "../headers.ts"
import { type SseEvent, sseEvents, sseFramesOf } from "../sse.ts"
import { bodyRef } from "./live.ts"
import type { BodyDigest, ReceivedBody } from "./types.ts"

/** What was received, when the client kept its size and hash; a re-encoding otherwise. */
function refOf(bytes: Uint8Array, type: string, digest: BodyDigest | undefined): BodyRef {
	return digest === undefined ? bodyRef(bytes, type) : { bytes: digest.bytes, mediaType: type, sha256: digest.sha256 }
}

function compactFrames(frames: readonly SseEvent[], mediaType: string): unknown {
	const compact = sseFramesOf(frames)
	const bytes = utf8Encode(JSON.stringify(compact))
	return bytes.byteLength <= INLINE_BODY_LIMIT
		? compact
		: bodyRef(bytes, primaryMediaType(mediaType, "text/event-stream"))
}

/**
 * An event stream's frames, or a text body inline or by reference; `null` for a body that is
 * neither, which the caller reads as bytes or JSON.
 */
function compactTextual(body: unknown, mediaType: string, digest: BodyDigest | undefined): { value: unknown } | null {
	const sse = mediaType.toLowerCase().includes("text/event-stream")
	/* Frames only under text/event-stream: a JSON array of strings, or a string that happens to
	 * start with "data:", is just that. */
	if (sse && Array.isArray(body)) {
		const frames = sseEvents(body)
		if (frames !== null) return { value: compactFrames(frames, mediaType) }
	}
	if (typeof body !== "string") return null
	const frames = sse ? sseEvents(body) : null
	if (frames !== null) return { value: compactFrames(frames, mediaType) }
	const bytes = utf8Encode(body)
	if (sse) {
		const inline = bytes.byteLength <= INLINE_BODY_LIMIT
		return { value: inline ? body : bodyRef(bytes, primaryMediaType(mediaType, "text/event-stream")) }
	}
	if (!isBinaryMediaType(mediaType) && bytes.byteLength <= INLINE_BODY_LIMIT) return { value: body }
	return { value: refOf(bytes, primaryMediaType(mediaType, "text/plain"), digest) }
}

export async function compactResponseBody(
	body: unknown,
	responseHeaders: Record<string, string>,
	received: ReceivedBody = {},
): Promise<unknown> {
	const { bytes: knownBytes, digest } = received
	if (body === undefined) return undefined
	if (isBodyRef(body) || isFormSnapshot(body)) return body
	const mediaType = presentHeader(responseHeaders, "content-type") ?? ""
	const textual = compactTextual(body, mediaType, digest)
	if (textual !== null) return textual.value
	const raw = await bytesOf(body)
	if (raw !== undefined) {
		return bodyRef(raw, primaryMediaType(mediaType, "application/octet-stream"))
	}
	if (body !== null && typeof body === "object") {
		if (knownBytes !== undefined && knownBytes <= INLINE_BODY_LIMIT) return body
		const bytes = utf8Encode(JSON.stringify(body))
		return bytes.byteLength <= INLINE_BODY_LIMIT
			? body
			: refOf(bytes, primaryMediaType(mediaType, "application/json"), digest)
	}
	return body
}
