import { describe, expect, it } from "vitest"
import { sha256Hex, utf8Encode } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"
import { bodyRef, holdsLiveBody } from "./live.ts"

describe("holdsLiveBody", () => {
	it("knows a live form, bytes, or an oversized string", () => {
		const live = [new FormData(), new URLSearchParams(), new Blob([]), new ArrayBuffer(1), new Uint8Array(2)]
		expect(live.map(holdsLiveBody)).toEqual([true, true, true, true, true])
		expect(holdsLiveBody("é".repeat(INLINE_BODY_LIMIT / 2 + 1))).toBe(true)
		expect(["x", "", 1, null, undefined, { a: 1 }].map(holdsLiveBody)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		])
	})
})

describe("bodyRef", () => {
	it("names bytes by size, type and hash", () => {
		const bytes = utf8Encode("abc")
		expect(bodyRef(bytes, "text/plain")).toEqual({ bytes: 3, mediaType: "text/plain", sha256: sha256Hex(bytes) })
	})
})
