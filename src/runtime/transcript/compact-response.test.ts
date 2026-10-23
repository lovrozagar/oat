import { describe, expect, it } from "vitest"
import { utf8Encode } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"
import { compactResponseBody } from "./compact-response.ts"
import { bodyRef } from "./live.ts"

const SSE = { "content-type": "text/event-stream; charset=utf-8" }
const JSON_TYPE = { "Content-Type": "application/json" }
const digest = { bytes: 99, sha256: "received" }
const long = "x".repeat(INLINE_BODY_LIMIT + 1)

describe("compactResponseBody, as kept already", () => {
	it("keeps nothing, and a body already compacted, as it is", async () => {
		expect(await compactResponseBody(undefined, SSE)).toBeUndefined()
		const stored = { bytes: 1, mediaType: "x/y", sha256: "h" }
		expect(await compactResponseBody(stored, {})).toBe(stored)
		const snapshot = { parts: [] }
		expect(await compactResponseBody(snapshot, {})).toBe(snapshot)
	})
})

describe("compactResponseBody, event streams", () => {
	it("keeps frames, read or listed, inline up to the limit", async () => {
		expect(await compactResponseBody("event: e\ndata: 1\n\n", SSE)).toEqual([{ data: "1", event: "e" }])
		expect(await compactResponseBody([{ data: { a: 1 }, event: "e" }], SSE)).toEqual([{ data: { a: 1 }, event: "e" }])
		const many = [{ data: long, event: "e" }]
		const compact = [{ data: long, event: "e" }]
		expect(await compactResponseBody(many, SSE)).toEqual(
			bodyRef(utf8Encode(JSON.stringify(compact)), "text/event-stream"),
		)
		expect(await compactResponseBody(`data: ${long}\n\n`, SSE)).toMatchObject({ mediaType: "text/event-stream" })
	})

	it("keeps a stream with no frames as text, by reference past the limit", async () => {
		expect(await compactResponseBody(": ping", SSE)).toBe(": ping")
		expect(await compactResponseBody(`: ${long}`, SSE, { digest })).toEqual(
			bodyRef(utf8Encode(`: ${long}`), "text/event-stream"),
		)
		expect(await compactResponseBody(["a"], SSE)).toEqual(["a"])
		expect(await compactResponseBody([1, 2], { "content-type": "text/event-stream" })).toEqual([1, 2])
	})

	it("reads frames only under text/event-stream", async () => {
		expect(await compactResponseBody("data: 1\n\n", {})).toBe("data: 1\n\n")
		expect(await compactResponseBody([{ data: 1, event: "e" }], JSON_TYPE)).toEqual([{ data: 1, event: "e" }])
	})
})

describe("compactResponseBody, other bodies", () => {
	it("keeps small text inline, and binary or long text by reference, by the received hash when known", async () => {
		expect(await compactResponseBody("hello", { "content-type": "text/plain" })).toBe("hello")
		expect(await compactResponseBody("png", { "content-type": "image/png" }, { bytes: 3, digest })).toEqual({
			bytes: 99,
			mediaType: "image/png",
			sha256: "received",
		})
		expect(await compactResponseBody(long, { "content-type": "text/csv; header=present" })).toEqual(
			bodyRef(utf8Encode(long), "text/csv"),
		)
		expect(await compactResponseBody(long, {})).toEqual(bodyRef(utf8Encode(long), "text/plain"))
	})

	it("keeps bytes by reference, and JSON inline up to the limit", async () => {
		const bytes = new Uint8Array([1, 2, 3])
		expect(await compactResponseBody(bytes, { "content-type": "image/png" })).toEqual(bodyRef(bytes, "image/png"))
		expect(await compactResponseBody(bytes, {})).toEqual(bodyRef(bytes, "application/octet-stream"))
		const big = { rows: long }
		expect(await compactResponseBody(big, JSON_TYPE, { bytes: 10 })).toBe(big)
		expect(await compactResponseBody(big, JSON_TYPE)).toEqual(
			bodyRef(utf8Encode(JSON.stringify(big)), "application/json"),
		)
		expect(await compactResponseBody(big, {}, { bytes: INLINE_BODY_LIMIT + 9, digest })).toEqual({
			bytes: 99,
			mediaType: "application/json",
			sha256: "received",
		})
		expect(await compactResponseBody({ a: 1 }, JSON_TYPE)).toEqual({ a: 1 })
		expect([await compactResponseBody(null, {}), await compactResponseBody(7, {})]).toEqual([null, 7])
	})
})
