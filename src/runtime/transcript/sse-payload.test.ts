import { describe, expect, it } from "vitest"
import { sha256Hex, utf8Encode } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"
import { bodyRef } from "./live.ts"
import { parseSseText, readSsePayload } from "./sse-payload.ts"

const SSE = { "content-type": "text/event-stream" }

/** A response whose body arrives in the chunks given, as a server would stream it. */
function streamed(chunks: Array<Uint8Array | undefined>): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk as Uint8Array)
			controller.close()
		},
	})
	return new Response(stream, { headers: SSE })
}

describe("parseSseText", () => {
	it("is frames when there are any, else the text, by reference past the limit", () => {
		expect(parseSseText("data: 1\n\n")).toEqual({ bodyBytes: 9, parsed: [{ data: "1", event: "message" }] })
		expect(parseSseText(": ping", 40)).toEqual({ bodyBytes: 40, parsed: ": ping" })
		const long = `: ${"z".repeat(INLINE_BODY_LIMIT)}`
		expect(parseSseText(long)).toEqual({
			bodyBytes: INLINE_BODY_LIMIT + 2,
			parsed: bodyRef(utf8Encode(long), "text/event-stream"),
		})
	})
})

describe("readSsePayload, small streams", () => {
	it("reads a stream chunk by chunk into frames, counting every byte", async () => {
		const res = streamed([utf8Encode("event: a\nda"), undefined, utf8Encode('ta: {"n":1}\n\ndata: 2')])
		expect(await readSsePayload(res)).toEqual({
			bodyBytes: 31,
			parsed: [
				{ data: { n: 1 }, event: "a" },
				{ data: "2", event: "message" },
			],
		})
	})

	it("keeps a stream with no frames as its text, the undecodable tail included", async () => {
		const res = streamed([utf8Encode(": ping\n"), new Uint8Array([0xc3])])
		expect(await readSsePayload(res)).toEqual({ bodyBytes: 8, parsed: ": ping\n�" })
	})

	it("reads a response with no body as empty text", async () => {
		expect(await readSsePayload(new Response(null, { headers: SSE }))).toEqual({ bodyBytes: 0, parsed: "" })
	})
})

describe("readSsePayload, large streams", () => {
	it("stops keeping the raw text past the limit, and names the stream by its hash", async () => {
		const head = utf8Encode(`: ${"z".repeat(INLINE_BODY_LIMIT)}\n`)
		const res = streamed([head, utf8Encode(": more\n"), new Uint8Array([0xc3])])
		const all = new Uint8Array([...head, ...utf8Encode(": more\n"), 0xc3])
		expect(await readSsePayload(res)).toEqual({
			bodyBytes: all.byteLength,
			parsed: { bytes: all.byteLength, mediaType: "text/event-stream", sha256: sha256Hex(all) },
		})
	})
})
