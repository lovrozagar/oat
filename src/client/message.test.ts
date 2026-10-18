import { describe, expect, it } from "vitest"
import { requestIdOf, requestMessageBytes, responseMessageBytes } from "./message.ts"

const url = new URL("http://api.test:8080/rows?a=1")

describe("requestMessageBytes", () => {
	it("counts the start line, the host and length it would send, and the text", () => {
		const head = "POST /rows?a=1 HTTP/1.1\r\nx: é\r\nhost: api.test:8080\r\ncontent-length: 2\r\n\r\n"
		expect(requestMessageBytes("POST", url, { x: "é" }, { bytes: 2, text: "hi" })).toBe(Buffer.byteLength(head) + 2)
	})

	it("keeps a host and length the caller set, and counts bytes it has no text for", () => {
		const head = "PUT /rows?a=1 HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\n"
		expect(requestMessageBytes("PUT", url, { "Content-Length": "4", Host: "h" }, { bytes: 4 })).toBe(
			Buffer.byteLength(head) + 4,
		)
	})

	it("sends no length for no body", () => {
		expect(requestMessageBytes("GET", url, {}, { bytes: 0 })).toBe(
			Buffer.byteLength("GET /rows?a=1 HTTP/1.1\r\nhost: api.test:8080\r\n\r\n"),
		)
	})
})

describe("responseMessageBytes", () => {
	it("counts the status line with its text, and a length when there is a body", () => {
		const response = new Response(null, { status: 200, statusText: "OK" })
		expect(responseMessageBytes(response, { a: "b" }, 3)).toBe(
			Buffer.byteLength("HTTP/1.1 200 OK\r\na: b\r\ncontent-length: 3\r\n\r\n") + 3,
		)
	})

	it("writes no reason phrase when there is none", () => {
		const response = new Response(null, { status: 204 })
		expect(responseMessageBytes(response, {}, 0)).toBe(Buffer.byteLength("HTTP/1.1 204\r\n\r\n"))
	})
})

describe("requestIdOf", () => {
	it("prefers the response's id, by any known name and case", () => {
		expect(requestIdOf({ "x-request-id": "mine" }, { "X-Correlation-Id": " theirs " })).toBe("theirs")
	})

	it("falls back to the request's, skips a blank one, and is empty without either", () => {
		expect(requestIdOf({ "request-id": "mine" }, { "x-request-id": "  " })).toBe("mine")
		expect(requestIdOf({}, {})).toBe("")
	})
})
