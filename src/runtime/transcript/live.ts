/**
 * In-memory exchange bodies: descriptors, not live FormData / Blobs / multi-MiB strings.
 *
 * The journal already spills those to `blobs/<sha256>` on disk. The transcript kept on
 * `Client` must not retain a second copy for the rest of the run — findings cite hops by
 * method, URL, status, headers, sizes, and content-addressed body refs.
 */

import { type BodyRef, isFormData, isRawBytes, isURLSearchParams } from "../exchange.ts"
import { sha256Hex, utf8Encode } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"

/** True when `value` is a live multipart/binary object or an oversized string still on the heap. */
export function holdsLiveBody(value: unknown): boolean {
	if (isFormData(value) || isURLSearchParams(value) || isRawBytes(value)) return true
	return typeof value === "string" && utf8Encode(value).byteLength > INLINE_BODY_LIMIT
}

/** A body by its size, type and hash, in place of the bytes. */
export function bodyRef(bytes: Uint8Array, mediaType: string): BodyRef {
	return { bytes: bytes.byteLength, mediaType, sha256: sha256Hex(bytes) }
}
