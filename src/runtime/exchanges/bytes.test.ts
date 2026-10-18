import { describe, expect, it } from "vitest"
import { bytesOf, sha256Hex, utf8Encode } from "./bytes.ts"

describe("sha256Hex / utf8Encode", () => {
	it("addresses bytes by their SHA-256, and encodes text as UTF-8", () => {
		expect(sha256Hex(utf8Encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
		expect([...utf8Encode("é")]).toEqual([195, 169])
		expect(utf8Encode("").byteLength).toBe(0)
	})
})

describe("bytesOf", () => {
	it("reads bytes, buffers, views and blobs", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4])
		expect(await bytesOf(bytes)).toBe(bytes)
		expect([...((await bytesOf(bytes.buffer)) as Uint8Array)]).toEqual([1, 2, 3, 4])
		expect([...((await bytesOf(new DataView(bytes.buffer, 1, 2))) as Uint8Array)]).toEqual([2, 3])
		expect([...((await bytesOf(new Blob([bytes]))) as Uint8Array)]).toEqual([1, 2, 3, 4])
	})

	it("is undefined for anything that is not binary", async () => {
		expect(await Promise.all(["x", { a: 1 }, null, undefined, 3].map(bytesOf))).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		])
	})
})
