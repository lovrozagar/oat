/** Body bytes: their content address, their UTF-8 encoding, and the bytes a binary body holds. */

import { createHash } from "node:crypto"

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

export function utf8Encode(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

/** The bytes of a binary body (bytes, a buffer or a view of one, a Blob); `undefined` for anything else. */
export async function bytesOf(value: unknown): Promise<Uint8Array | undefined> {
	if (value instanceof Uint8Array) return value
	if (value instanceof ArrayBuffer) return new Uint8Array(value)
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
	if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer())
	return undefined
}
