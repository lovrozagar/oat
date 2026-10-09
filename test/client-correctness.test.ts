import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { formPairs } from "../src/runtime/body.ts"
import { compactResponseBody } from "../src/runtime/transcript.ts"
import { AuthRefreshError, Client, toCurl } from "../src/runtime/client.ts"
import {
	REDACTED,
	redactHeaders,
	redactJson,
	redactUrl,
	registerSecret,
	registerSecretHeader,
} from "../src/runtime/redact.ts"

describe("one redactor", () => {
	it("scrubs an issued credential wherever it appears", () => {
		registerSecret("Bearer tok_live_123456")
		expect(redactJson({ message: "rejected tok_live_123456", nested: ["tok_live_123456"] })).toEqual({
			message: `rejected ${REDACTED}`,
			nested: [REDACTED],
		})
		expect(redactUrl("https://x.test/a?next=tok_live_123456")).not.toContain("tok_live_123456")
	})

	it("matches secret keys by family and a principal's own header name", () => {
		registerSecretHeader("X-Tenant-Credential")
		expect(redactJson({ client_secret: "s", refreshToken: "r", sessionId: "q", total: 3 })).toEqual({
			client_secret: REDACTED,
			refreshToken: REDACTED,
			sessionId: REDACTED,
			total: 3,
		})
		expect(redactHeaders({ "x-tenant-credential": "v", accept: "json" })).toEqual({
			accept: "json",
			"x-tenant-credential": REDACTED,
		})
	})

	it("keeps secrets out of repro scripts, and sends a form field by field", () => {
		registerSecret("hunter2-password")
		const curl = toCurl({
			at: 0,
			durationMs: 0,
			method: "POST",
			requestBody: new URLSearchParams([
				["username", "oat"],
				["password", "hunter2-password"],
			]),
			requestBytes: 0,
			requestHeaders: { authorization: "Bearer tok_live_123456" },
			requestId: "",
			responseBody: null,
			responseBytes: 0,
			responseHeaders: {},
			seq: 1,
			status: 200,
			url: "https://x.test/login",
		})
		expect(curl).not.toContain("hunter2-password")
		expect(curl).not.toContain("tok_live_123456")
		expect(curl).toContain("--data-urlencode 'username=oat'")
	})
})

describe("form encoding per the operation's encoding", () => {
	it("repeats array keys and spreads objects by default", () => {
		expect(formPairs("tags", ["a", "b"], undefined)).toEqual([
			["tags", "a"],
			["tags", "b"],
		])
		expect(formPairs("point", { x: 1, y: 2 }, undefined)).toEqual([
			["x", "1"],
			["y", "2"],
		])
	})

	it("honours deepObject, explode false and a JSON content type", () => {
		expect(formPairs("point", { x: 1 }, { style: "deepObject" })).toEqual([["point[x]", "1"]])
		expect(formPairs("tags", ["a", "b"], { explode: false, style: "pipeDelimited" })).toEqual([["tags", "a|b"]])
		expect(formPairs("meta", { k: 1 }, { contentType: "application/json" })).toEqual([["meta", '{"k":1}']])
	})
})

let url = ""
let hits = 0
let close = async (): Promise<void> => {}
beforeAll(async () => {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		hits += 1
		/* Drop the connection mid-request: the request may well have been processed. */
		if (req.url === "/reset") {
			req.socket.destroy()
			return
		}
		if (req.url === "/pdf") {
			res.writeHead(200, { "content-type": "application/pdf" })
			res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff]))
			return
		}
		if (req.url === "/odd-charset") {
			res.writeHead(200, { "content-type": "text/plain; charset=not-a-charset" })
			res.end("plain")
			return
		}
		if (req.url === "/expired") {
			res.writeHead(401, { "content-type": "application/json" })
			res.end("{}")
			return
		}
		res.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1" })
		res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	close = () => new Promise((resolve) => server.close(() => resolve()))
})
afterAll(() => close())

describe("the client", () => {
	it("never resends a POST whose connection broke mid-request", async () => {
		const client = new Client(url, {}, 4, undefined, undefined, undefined, { retries: 3 })
		hits = 0
		await expect(client.request("POST", "/reset", { body: { a: 1 } })).rejects.toThrow()
		expect(hits).toBe(1)
	})

	it("resends a GET, which is safe to repeat", async () => {
		const client = new Client(url, {}, 4, undefined, undefined, undefined, { retries: 1 })
		hits = 0
		await expect(client.get("/reset")).rejects.toThrow()
		expect(hits).toBe(2)
	})

	it("decodes text by its declared charset and counts the bytes on the wire", async () => {
		const exchange = await new Client(url).get("/latin1")
		expect(exchange.responseBody).toBe("café")
		expect(exchange.responseBytes).toBeGreaterThan(0)
	})
	it("reads a body whose charset label is unknown as UTF-8", async () => {
		expect((await new Client(url).get("/odd-charset")).responseBody).toBe("plain")
	})

	it("raises a failed refresh as its own error, naming the principal", async () => {
		const client = new Client(url)
		client.setPrincipalResolver(() => "alpha")
		await expect(
			client.get("/expired", {
				refreshIfStale: async (force) => {
					if (force === true) throw new Error("refresh endpoint said 500")
				},
			}),
		).rejects.toThrow(AuthRefreshError)
	})
	it("keeps a binary body as its bytes", async () => {
		const exchange = await new Client(url).get("/pdf")
		expect(exchange.responseBody).toBeInstanceOf(Uint8Array)
		expect(exchange.responseBytes).toBeGreaterThan(5)
	})

	it("reads an array under text/event-stream as frames only when it is frames", async () => {
		expect(await compactResponseBody([1, 2], { "content-type": "text/event-stream" })).toEqual([1, 2])
	})
})
