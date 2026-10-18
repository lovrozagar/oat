import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { type Route, routed } from "./routes.ts"
import { answer } from "./serve.ts"

function request(method: string, path: string) {
	return referenceRequest(method, new URL(path, "http://suite.test"), { headers: {}, read: async () => "" })
}

const ROUTES: Route[] = [
	{ method: "GET", path: /^\/v1\/things$/, reply: (id) => answer(200, { id }) },
	{ method: "GET", path: /^\/v1\/(\w+)\/([^/]+)$/, reply: (id) => answer(200, { id }) },
	{ method: "DELETE", path: /^\/v1\/things\/([^/]+)$/, reply: () => answer(204) },
]

describe("routed", () => {
	it("answers from the first route whose method and path match, with its last group undecoded", async () => {
		const handle = routed(ROUTES)
		expect((await handle(request("GET", "/v1/things/a%20b"))).body).toBe('{"id":"a%20b"}')
		expect((await handle(request("DELETE", "/v1/things/a"))).status).toBe(204)
	})

	it("hands a route that captures nothing the whole path", async () => {
		expect((await routed(ROUTES)(request("GET", "/v1/things"))).body).toBe('{"id":"/v1/things"}')
	})

	it("falls back to a bare 404, or the answer it is given, on an unknown method or path", async () => {
		expect(await routed(ROUTES)(request("PUT", "/v1/things/a"))).toEqual(answer(404))
		const missing = answer(404, { error_key: "not_found" })
		expect(await routed(ROUTES, missing)(request("GET", "/v2"))).toBe(missing)
	})
})
