import { describe, expect, it, vi } from "vitest"
import { referenceRequest, respond } from "./wire.ts"

describe("respond", () => {
	it("serializes the body as JSON with its byte length", () => {
		const answer = respond(201, { name: "café" })
		expect(answer).toEqual({
			body: '{"name":"café"}',
			headers: { "content-length": "16", "content-type": "application/json" },
			status: 201,
		})
	})

	it("adds extra headers, which may override the defaults", () => {
		const answer = respond(429, [], { "content-type": "text/plain", "retry-after": "0" })
		expect(answer.headers).toEqual({ "content-length": "2", "content-type": "text/plain", "retry-after": "0" })
	})
})

describe("referenceRequest", () => {
	it("upper-cases the method and keeps the url and headers", () => {
		const url = new URL("http://reference.test/health")
		const request = referenceRequest("patch", url, { accept: "*/*" }, async () => "")
		expect(request.method).toBe("PATCH")
		expect(request.url).toBe(url)
		expect(request.headers).toEqual({ accept: "*/*" })
	})

	it("reads the body once, however often it is asked", async () => {
		const read = vi.fn<() => Promise<string>>(async () => "payload")
		const request = referenceRequest("POST", new URL("http://reference.test/"), {}, read)
		expect(await request.text()).toBe("payload")
		expect(await request.text()).toBe("payload")
		expect(read).toHaveBeenCalledTimes(1)
	})
})
