import { describe, expect, it } from "vitest"
import { REDACTED, Redactor } from "../../security/redact.ts"
import { exchangeOf } from "../exchanges/__fixtures__/exchange.ts"
import { INLINE_BODY_LIMIT } from "../exchanges/media.ts"
import { releaseTranscriptBodies } from "./release.ts"

describe("releaseTranscriptBodies", () => {
	it("compacts both bodies in place, with the sizes and hashes the client kept", async () => {
		const form = new FormData()
		form.append("password", "p")
		const exchange = exchangeOf({
			requestBody: form,
			responseBody: "x".repeat(INLINE_BODY_LIMIT + 1),
			responseDigest: { bytes: 5, sha256: "received" },
			responseHeaders: { "content-type": "text/plain" },
		})
		await releaseTranscriptBodies(exchange, new Redactor())
		expect(exchange.requestBody).toEqual({ parts: [{ field: "password", value: REDACTED }] })
		expect(exchange.responseBody).toEqual({ bytes: 5, mediaType: "text/plain", sha256: "received" })
	})

	it("uses the request's hash, and keeps a small JSON response as it is", async () => {
		const exchange = exchangeOf({ requestBody: "sent", requestDigest: { bytes: 4, sha256: "out" } })
		await releaseTranscriptBodies(exchange, new Redactor())
		expect([exchange.requestBody, exchange.responseBody]).toEqual([
			{ bytes: 4, mediaType: "text/plain", sha256: "out" },
			{ ok: true },
		])
	})
})
