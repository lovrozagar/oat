/** A request or response body as the journal writes it: redacted, inline, or by blob reference. */

import { presentHeader } from "../headers.ts"
import {
	describeRequestBody,
	type Exchange,
	isBodyRef,
	isFormData,
	isFormSnapshot,
	isURLSearchParams,
} from "../exchange.ts"
import type { Redactor } from "../../security/redact.ts"
import { type SseEvent, sseEvents } from "../sse.ts"
import type { BlobStore } from "./blobs.ts"
import { bytesOf, utf8Encode } from "./bytes.ts"
import { formFieldPart, formFilePart } from "./form-parts.ts"
import { isBinaryMediaType, primaryMediaType } from "./media.ts"

function redactedFrames(frames: readonly SseEvent[], redactor: Redactor): unknown[] {
	return frames.map((frame) => ({ data: redactor.json(frame.data), event: frame.event }))
}

/** A body already stored, as frames or a reference: nothing is left to write. */
function isPersisted(body: unknown): boolean {
	return isBodyRef(body) || isFormSnapshot(body)
}

export async function persistRequestBody(body: unknown, store: BlobStore): Promise<unknown> {
	if (body === undefined) return undefined
	if (isPersisted(body)) return body
	if (isFormData(body)) {
		const parts: unknown[] = []
		for (const [field, value] of body.entries()) {
			if (typeof value === "string") {
				parts.push(formFieldPart(field, value))
				continue
			}
			const bytes = new Uint8Array(await value.arrayBuffer())
			const blob = await store.put(bytes)
			parts.push(formFilePart(field, value, blob))
		}
		return { parts }
	}
	if (isURLSearchParams(body)) return store.redactor.json(Object.fromEntries(body.entries()))
	const raw = await bytesOf(body)
	if (raw !== undefined) {
		const blob = await store.put(raw)
		return { ...blob, mediaType: "application/octet-stream" }
	}
	if (typeof body === "string") return store.spillText(body, "text/plain")
	if (body !== null && typeof body === "object") return store.persistJson(body, "application/json")
	return describeRequestBody(body)
}

/**
 * A response body that is neither an event stream nor binary: frames when the text reads as
 * events, text inline or spilled, JSON redacted. Returns the store's promise as it is, so the
 * caller resolves exactly when the write does.
 */
function persistPlainResponse(body: unknown, mediaType: string, store: BlobStore): unknown {
	if (body === undefined) return undefined
	if (typeof body === "string") {
		const asFrames = sseEvents(body)
		if (asFrames !== null) return redactedFrames(asFrames, store.redactor)
		return store.spillText(body, primaryMediaType(mediaType, "text/plain"))
	}
	if (body !== null && typeof body === "object") {
		return store.persistJson(body, primaryMediaType(mediaType, "application/json"))
	}
	return body
}

export async function persistResponseBody(exchange: Exchange, store: BlobStore): Promise<unknown> {
	const mediaType = presentHeader(exchange.responseHeaders, "content-type") ?? ""
	const body = exchange.responseBody
	if (isPersisted(body)) return body
	if (mediaType.toLowerCase().includes("text/event-stream")) {
		const frames = sseEvents(body)
		if (frames !== null) return redactedFrames(frames, store.redactor)
		if (typeof body === "string") return store.spillText(body, primaryMediaType(mediaType, "text/event-stream"))
	}
	if (isBinaryMediaType(mediaType)) {
		const bytes =
			typeof body === "string" ? utf8Encode(body) : ((await bytesOf(body)) ?? utf8Encode(JSON.stringify(body)))
		const blob = await store.put(bytes)
		return { ...blob, mediaType: primaryMediaType(mediaType, "application/octet-stream") }
	}
	return persistPlainResponse(body, mediaType, store)
}
