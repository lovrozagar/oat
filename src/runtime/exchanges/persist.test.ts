import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { REDACTED, Redactor } from "../../security/redact.ts"
import { exchangeOf } from "./__fixtures__/exchange.ts"
import { type BlobStore, createBlobStore } from "./blobs.ts"
import { sha256Hex, utf8Encode } from "./bytes.ts"
import { INLINE_BODY_LIMIT } from "./media.ts"
import { persistRequestBody, persistResponseBody } from "./persist.ts"

let dir = ""
let store: BlobStore

const ref = (text: string, mediaType: string) => ({
	bytes: utf8Encode(text).byteLength,
	mediaType,
	sha256: sha256Hex(utf8Encode(text)),
})
const response = (body: unknown, contentType?: string) =>
	exchangeOf({ responseBody: body, responseHeaders: contentType === undefined ? {} : { "Content-Type": contentType } })

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "oat-persist-"))
	mkdirSync(join(dir, "blobs"))
	store = createBlobStore(dir, new Redactor())
})

afterEach(() => {
	rmSync(dir, { force: true, recursive: true })
})

describe("persistRequestBody", () => {
	it("keeps nothing, and a body already stored, as it is", async () => {
		expect(await persistRequestBody(undefined, store)).toBeUndefined()
		const stored = { bytes: 1, mediaType: "x/y", sha256: "h" }
		expect(await persistRequestBody(stored, store)).toBe(stored)
		const snapshot = { parts: [] }
		expect(await persistRequestBody(snapshot, store)).toBe(snapshot)
	})

	it("writes a form field by field, its files as blobs", async () => {
		const form = new FormData()
		form.append("password", "hunter2")
		form.append("doc", new Blob(["abc"], { type: "text/plain" }), "a.txt")
		expect(await persistRequestBody(form, store)).toEqual({
			parts: [
				{ field: "password", value: REDACTED },
				{ field: "doc", filename: "a.txt", ...ref("abc", "text/plain") },
			],
		})
		const fields = new URLSearchParams([
			["password", "p"],
			["q", "1"],
		])
		expect(await persistRequestBody(fields, store)).toEqual({ password: REDACTED, q: "1" })
	})

	it("writes bytes as a blob, text and JSON inline or spilled, and anything else described", async () => {
		expect(await persistRequestBody(utf8Encode("raw"), store)).toEqual(ref("raw", "application/octet-stream"))
		expect(await persistRequestBody("text", store)).toBe("text")
		expect(await persistRequestBody({ token: "t" }, store)).toEqual({ token: REDACTED })
		expect(await persistRequestBody(null, store)).toBeNull()
		expect(await persistRequestBody(7, store)).toBe(7)
	})
})

describe("persistResponseBody, event streams", () => {
	it("writes frames redacted, and a stream with none as text", async () => {
		const frames = await persistResponseBody(
			response('event: tick\ndata: {"password":"p"}\n\n', "text/event-stream"),
			store,
		)
		expect(frames).toEqual([{ data: { password: REDACTED }, event: "tick" }])
		const listed = await persistResponseBody(
			response([{ data: "x", event: "e" }], "text/event-stream; charset=utf-8"),
			store,
		)
		expect(listed).toEqual([{ data: "x", event: "e" }])
		const big = `: ${"z".repeat(INLINE_BODY_LIMIT)}`
		expect(await persistResponseBody(response(big, "text/event-stream; charset=utf-8"), store)).toEqual(
			ref(big, "text/event-stream"),
		)
		expect(await persistResponseBody(response({ a: 1 }, "text/event-stream"), store)).toEqual({ a: 1 })
	})
})

describe("persistResponseBody, other bodies", () => {
	it("keeps a body already stored as it is", async () => {
		const stored = { bytes: 1, mediaType: "x/y", sha256: "h" }
		expect(await persistResponseBody(response(stored, "image/png"), store)).toBe(stored)
	})

	it("writes a binary body as a blob, whatever it was read as", async () => {
		expect(await persistResponseBody(response("png", "image/png"), store)).toEqual(ref("png", "image/png"))
		expect(await persistResponseBody(response(utf8Encode("pdf"), "application/pdf"), store)).toEqual(
			ref("pdf", "application/pdf"),
		)
		expect(await persistResponseBody(response({ a: 1 }, "application/zip"), store)).toEqual(
			ref('{"a":1}', "application/zip"),
		)
	})

	it("writes text, frames found in text, and JSON as the type names them", async () => {
		expect(await persistResponseBody(response(undefined), store)).toBeUndefined()
		expect(await persistResponseBody(response("data: hi\n\n"), store)).toEqual([{ data: "hi", event: "message" }])
		const long = "t".repeat(INLINE_BODY_LIMIT + 1)
		expect(await persistResponseBody(response(long, "text/csv; header=present"), store)).toEqual(ref(long, "text/csv"))
		expect(await persistResponseBody(response(long), store)).toEqual(ref(long, "text/plain"))
		expect(await persistResponseBody(response({ secret: "s" }, "application/json"), store)).toEqual({
			secret: REDACTED,
		})
		const big = { rows: "r".repeat(INLINE_BODY_LIMIT) }
		expect(await persistResponseBody(response(big), store)).toEqual(ref(JSON.stringify(big), "application/json"))
		expect(await persistResponseBody(response(null), store)).toBeNull()
		expect(await persistResponseBody(response(5, "text/plain"), store)).toBe(5)
	})
})
