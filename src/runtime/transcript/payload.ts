/** A fetch Response read once: its parsed body, its size on the wire, and its hash when large. */

import { sha256Hex } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT, isBinaryMediaType } from "../exchanges/media.ts"
import { readSsePayload } from "./sse-payload.ts"
import type { ResponsePayload } from "./types.ts"

function decodeText(bytes: Uint8Array, contentType: string): string {
	const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes)
	} catch {
		/* An unknown label is the server's mistake; UTF-8 is the only sensible reading left. */
		return new TextDecoder("utf-8").decode(bytes)
	}
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
	/* A body that will be stored by reference is hashed now, while its received bytes exist:
	 * re-encoding the parsed value later would hash something the server never sent. */
	const digest = bodyBytes > INLINE_BODY_LIMIT ? { bytes: bodyBytes, sha256: sha256Hex(bytes) } : undefined
	const withDigest = digest === undefined ? {} : { digest }
	if (isBinaryMediaType(contentType)) return { bodyBytes, parsed: bytes, ...withDigest }
	const text = decodeText(bytes, contentType)
	try {
		return { bodyBytes, parsed: JSON.parse(text) as unknown, ...withDigest }
	} catch {
		return { bodyBytes, parsed: text, ...withDigest }
	}
}
