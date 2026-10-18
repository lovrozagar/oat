/** Content-addressed body storage under the journal's `blobs/`, and the inline-or-spill decision. */

import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Redactor } from "../../security/redact.ts"
import { sha256Hex, utf8Encode } from "./bytes.ts"
import { INLINE_BODY_LIMIT } from "./media.ts"

export interface StoredBlob {
	sha256: string
	bytes: number
}

export interface BlobStore {
	readonly redactor: Redactor
	/** Writes the bytes once under their hash; a second put of the same bytes writes nothing. */
	put(bytes: Uint8Array): Promise<StoredBlob>
	/** Text inline, or by reference once it is past the inline limit. */
	spillText(text: string, mediaType: string): Promise<string | (StoredBlob & { mediaType: string })>
	/** A JSON value redacted, inline or by reference once its serialization is past the limit. */
	persistJson(value: unknown, mediaType: string): Promise<unknown>
}

export function createBlobStore(dir: string, redactor: Redactor): BlobStore {
	const writtenBlobs = new Set<string>()

	const put = async (bytes: Uint8Array): Promise<StoredBlob> => {
		const sha256 = sha256Hex(bytes)
		if (!writtenBlobs.has(sha256)) {
			const path = join(dir, "blobs", sha256)
			if (!existsSync(path)) await writeFile(path, bytes)
			writtenBlobs.add(sha256)
		}
		return { bytes: bytes.byteLength, sha256 }
	}

	return {
		async persistJson(value, mediaType) {
			const redacted = redactor.json(value)
			const bytes = utf8Encode(JSON.stringify(redacted))
			if (bytes.byteLength <= INLINE_BODY_LIMIT) return redacted
			const blob = await put(bytes)
			return { ...blob, mediaType }
		},
		put,
		redactor,
		async spillText(text, mediaType) {
			const bytes = utf8Encode(text)
			if (bytes.byteLength <= INLINE_BODY_LIMIT) return text
			const blob = await put(bytes)
			return { ...blob, mediaType }
		},
	}
}
