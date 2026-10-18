import { describe, expect, it } from "vitest"
import { sha256Hex, utf8Encode } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"
import { REDACTED, Redactor } from "../../security/redact.ts"
import { compactRequestBody } from "./compact-request.ts"
import { bodyRef } from "./live.ts"

const redactor = new Redactor()

describe("compactRequestBody, forms", () => {
	it("keeps a form field by field, scrubbing secret fields and what the run was issued", async () => {
		const issued = new Redactor()
		issued.registerSecret("issued-token-value")
		const form = new URLSearchParams([
			["note", "sent issued-token-value"],
			["tag", "a"],
			["tag", "b"],
			["tag", "c"],
		])
		expect(await compactRequestBody(form, issued)).toEqual({ note: `sent ${REDACTED}`, tag: ["a", "b", "c"] })
		const multipart = new FormData()
		multipart.append("password", "hunter2")
		multipart.append("file", new Blob(["abc"], { type: "text/plain" }), "a.txt")
		expect(await compactRequestBody(multipart, redactor)).toEqual({
			parts: [
				{ field: "password", value: REDACTED },
				{ bytes: 3, field: "file", filename: "a.txt", mediaType: "text/plain", sha256: sha256Hex(utf8Encode("abc")) },
			],
		})
	})

	it("keeps nothing, and a body already compacted, as it is", async () => {
		expect(await compactRequestBody(undefined, redactor)).toBeUndefined()
		const snapshot = { parts: [{ field: "a", value: "b" }] }
		expect(await compactRequestBody(snapshot, redactor)).toBe(snapshot)
		const stored = { bytes: 1, mediaType: "x/y", sha256: "h" }
		expect(await compactRequestBody(stored, redactor)).toBe(stored)
	})
})

describe("compactRequestBody, bytes and text", () => {
	it("stores raw bytes as a reference", async () => {
		const bytes = new Uint8Array([1, 2])
		expect(await compactRequestBody(bytes, redactor)).toEqual(bodyRef(bytes, "application/octet-stream"))
	})

	it("uses the hash taken when the body went out", async () => {
		const digest = { bytes: 9, sha256: "sent" }
		expect(await compactRequestBody("text", redactor, { digest })).toEqual({
			bytes: 9,
			mediaType: "text/plain",
			sha256: "sent",
		})
		expect(await compactRequestBody({ a: 1 }, redactor, { digest })).toEqual({
			bytes: 9,
			mediaType: "application/json",
			sha256: "sent",
		})
	})

	it("keeps text and JSON inline up to the limit, and by reference past it", async () => {
		const long = "x".repeat(INLINE_BODY_LIMIT + 1)
		expect(await compactRequestBody("short", redactor)).toBe("short")
		expect(await compactRequestBody(long, redactor)).toEqual(bodyRef(utf8Encode(long), "text/plain"))
		const small = { a: 1 }
		expect(await compactRequestBody(small, redactor)).toBe(small)
		const big = { rows: long }
		expect(await compactRequestBody(big, redactor)).toEqual(
			bodyRef(utf8Encode(JSON.stringify(big)), "application/json"),
		)
		expect(await compactRequestBody(big, redactor, { bytes: 10 })).toBe(big)
		expect(await compactRequestBody(big, redactor, { bytes: INLINE_BODY_LIMIT + 1 })).toMatchObject({
			mediaType: "application/json",
		})
		expect([await compactRequestBody(null, redactor), await compactRequestBody(4, redactor)]).toEqual([null, 4])
	})
})
