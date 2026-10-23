/** An event-stream response read incrementally, so the raw concatenation never lands on the transcript. */

import { createHash } from "node:crypto"
import { utf8Encode } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"
import { parseSse, SseParser, sseFramesOf } from "../sse.ts"
import { bodyRef } from "./live.ts"
import type { ResponsePayload } from "./types.ts"

export function parseSseText(text: string, bodyBytes: number = utf8Encode(text).byteLength): ResponsePayload {
	const events = parseSse(text)
	if (events.length > 0) return { bodyBytes, parsed: sseFramesOf(events) }
	if (bodyBytes > INLINE_BODY_LIMIT) return { bodyBytes, parsed: bodyRef(utf8Encode(text), "text/event-stream") }
	return { bodyBytes, parsed: text }
}

export async function readSsePayload(response: Response): Promise<ResponsePayload> {
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
