import { describe, expect, it } from "vitest"
import { type FakeServer, fakeCreate, serve } from "./__fixtures__/fake-http.ts"
import { listen } from "./node.ts"
import { type ReferenceRequest, respond } from "./wire.ts"

/* Listens with a handler that answers with what it was sent. */
async function echoing() {
	const servers: FakeServer[] = []
	const listening = await listen(
		async (request: ReferenceRequest) =>
			respond(201, {
				body: await request.text(),
				headers: request.headers,
				method: request.method,
				path: `${request.url.pathname}${request.url.search}`,
			}),
		fakeCreate(servers, 5555),
	)
	return { listening, server: servers[0] as FakeServer }
}

describe("listen", () => {
	it("binds 127.0.0.1 on a port the system picks, and says where", async () => {
		const { listening, server } = await echoing()
		expect(server.bound).toEqual({ host: "127.0.0.1", port: 0 })
		expect(listening.origin).toBe("http://127.0.0.1:5555")
	})

	it("drops every connection before it stops listening", async () => {
		const { listening, server } = await echoing()
		await listening.close()
		expect(server.calls).toEqual(["closeAllConnections", "close"])
	})

	it("translates a request in and its answer out", async () => {
		const { server } = await echoing()
		const served = await serve(server.listener, {
			chunks: ['{"a":', "1}"],
			headers: { "content-type": "application/json", "set-cookie": ["a", "b"] },
			method: "post",
			url: "/v1/x?y=1",
		})
		expect(served.status).toBe(201)
		expect(served.headers["content-type"]).toBe("application/json")
		expect(JSON.parse(served.body)).toEqual({
			body: '{"a":1}',
			headers: { "content-type": "application/json" },
			method: "POST",
			path: "/v1/x?y=1",
		})
	})

	it("reads a request with no method or url as a GET of the root", async () => {
		const { server } = await echoing()
		const served = await serve(server.listener, {})
		expect(JSON.parse(served.body)).toEqual({ body: "", headers: {}, method: "GET", path: "/" })
	})
})
