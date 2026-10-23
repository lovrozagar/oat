import { describe, expect, it } from "vitest"
import { Redactor } from "../security/redact.ts"
import { transport } from "./__fixtures__/transport.ts"
import { Client } from "./client.ts"

/* How the client reads an answer's body: by its declared charset, or as its bytes. */

/* A client whose every answer is `body` under `contentType`. */
function answering(body: ConstructorParameters<typeof Response>[0], contentType: string): Client {
	const wire = transport(() => new Response(body, { headers: { "content-type": contentType }, status: 200 }))
	return new Client({ baseUrl: "http://api.test", network: { fetchImpl: wire.fetch }, redactor: new Redactor() })
}

describe("an answer's body", () => {
	it("is decoded by its declared charset, and its bytes on the wire are counted", async () => {
		const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
		const exchange = await answering(latin1, "text/plain; charset=iso-8859-1").get("/latin1", {
			as: { anonymous: true },
		})
		expect(exchange.responseBody).toBe("café")
		expect(exchange.responseBytes).toBeGreaterThan(0)
	})

	it("is read as UTF-8 when its charset label is unknown", async () => {
		const exchange = await answering("plain", "text/plain; charset=not-a-charset").get("/odd-charset", {
			as: { anonymous: true },
		})
		expect(exchange.responseBody).toBe("plain")
	})

	it("is kept as its bytes when binary", async () => {
		const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff])
		const exchange = await answering(pdf, "application/pdf").get("/pdf", { as: { anonymous: true } })
		expect(exchange.responseBody).toBeInstanceOf(Uint8Array)
		expect(exchange.responseBytes).toBeGreaterThan(5)
	})
})
