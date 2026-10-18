import { describe, expect, it } from "vitest"
import { asFetch } from "./fetch.ts"
import type { ReferenceRequest } from "./wire.ts"
import { respond } from "./wire.ts"

/* A handler that answers with what it was sent. */
function echo(seen: ReferenceRequest[]) {
	return asFetch(async (request) => {
		seen.push(request)
		return respond(200, { body: await request.text(), method: request.method, path: request.url.pathname })
	})
}

describe("asFetch", () => {
	it("hands the handler the request, and the client its answer", async () => {
		const seen: ReferenceRequest[] = []
		const send = echo(seen)
		const answer = await send("http://reference.test/v1/x?y=1", {
			body: '{"a":1}',
			headers: { "Content-Type": "application/json", "X-Trace": "t" },
			method: "post",
		})
		expect(answer.status).toBe(200)
		expect(answer.headers.get("content-type")).toBe("application/json")
		expect(await answer.json()).toEqual({ body: '{"a":1}', method: "POST", path: "/v1/x" })
		expect(seen[0]?.url.search).toBe("?y=1")
		expect(seen[0]?.headers).toMatchObject({ "content-type": "application/json", "x-trace": "t" })
	})

	it("reads a streamed body", async () => {
		const send = echo([])
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("streamed"))
				controller.close()
			},
		})
		const answer = await send(
			new Request("http://reference.test/", { body, duplex: "half", method: "PUT" } as RequestInit),
		)
		expect(((await answer.json()) as { body: string }).body).toBe("streamed")
	})

	it("answers a 204 without a body", async () => {
		const send = asFetch(async () => ({ body: "", headers: {}, status: 204 }))
		const answer = await send("http://reference.test/")
		expect(answer.status).toBe(204)
		expect(await answer.text()).toBe("")
	})
})
