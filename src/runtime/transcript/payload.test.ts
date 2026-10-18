import { describe, expect, it } from "vitest"
import { sha256Hex, utf8Encode } from "../exchanges/bytes.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"
import { readResponsePayload } from "./payload.ts"

const answer = (body: ConstructorParameters<typeof Response>[0], contentType?: string): Response =>
	new Response(body, contentType === undefined ? {} : { headers: { "content-type": contentType } })

describe("readResponsePayload", () => {
	it("reads an event stream as frames", async () => {
		expect(await readResponsePayload(answer("data: 1\n\n", "Text/Event-Stream"))).toEqual({
			bodyBytes: 9,
			parsed: [{ data: "1", event: "message" }],
		})
	})

	it("reads JSON when it parses, text when it does not, and an empty body as null", async () => {
		expect(await readResponsePayload(answer('{"a":1}', "application/json"))).toEqual({ bodyBytes: 7, parsed: { a: 1 } })
		expect(await readResponsePayload(answer("plain"))).toEqual({ bodyBytes: 5, parsed: "plain" })
		/* Bytes carry no Content-Type of their own: the body is read as UTF-8 text. */
		expect(await readResponsePayload(answer(utf8Encode("[1]")))).toEqual({ bodyBytes: 3, parsed: [1] })
		expect(await readResponsePayload(answer(null, "application/json"))).toEqual({ bodyBytes: 0, parsed: null })
	})

	it("keeps binary bytes as bytes", async () => {
		const read = await readResponsePayload(answer(new Uint8Array([1, 2]), "image/png"))
		expect([read.bodyBytes, [...(read.parsed as Uint8Array)]]).toEqual([2, [1, 2]])
	})

	it("decodes text by the charset it declares, and by UTF-8 when the label is unknown", async () => {
		const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
		expect((await readResponsePayload(answer(latin1, 'text/plain; charset="iso-8859-1"'))).parsed).toBe("café")
		expect((await readResponsePayload(answer(utf8Encode("café"), "text/plain; charset=nonsense"))).parsed).toBe("café")
	})

	it("hashes a body too large to keep inline, as received", async () => {
		const big = utf8Encode(JSON.stringify({ rows: "r".repeat(INLINE_BODY_LIMIT) }))
		const read = await readResponsePayload(answer(big, "application/json"))
		expect(read.digest).toEqual({ bytes: big.byteLength, sha256: sha256Hex(big) })
		expect(read.parsed).toEqual({ rows: "r".repeat(INLINE_BODY_LIMIT) })
		const text = utf8Encode("t".repeat(INLINE_BODY_LIMIT + 1))
		expect((await readResponsePayload(answer(text, "text/plain"))).digest?.bytes).toBe(INLINE_BODY_LIMIT + 1)
		expect((await readResponsePayload(answer(text, "application/octet-stream"))).digest?.sha256).toBe(sha256Hex(text))
	})
})
