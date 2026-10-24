import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { bearerSecurity } from "../harness/security.ts"
import { publicCatalog } from "./public-catalog.ts"

const ORIGIN = "http://catalog.test"
const AUTH = { authorization: "Bearer tok_alpha" }

/** A request's body and headers: none, and the owner's token, unless given. */
interface Sent {
	body?: string
	headers?: Record<string, string>
}

function request(method: string, path: string, { body = "", headers = AUTH }: Sent = {}) {
	return referenceRequest(method, new URL(`${ORIGIN}${path}`), { headers, read: async () => body })
}

const json = (text: string): unknown => JSON.parse(text)

describe("publicCatalog", () => {
	it("serves its document to anyone, and nothing else without a known token", async () => {
		const handle = publicCatalog()
		const spec = await handle(request("GET", "/v1/openapi/spec", { headers: {} }))
		expect(spec.status).toBe(200)
		expect(json(spec.body)).toMatchObject({ openapi: "3.1.0", ...bearerSecurity() })
		expect((await handle(request("GET", "/v1/templates", { headers: {} }))).status).toBe(401)
		expect((await handle(request("GET", "/v1/templates", { headers: { authorization: "Bearer nope" } }))).status).toBe(
			401,
		)
		expect((await handle(request("GET", "/v1/templates", { headers: { authorization: "Basic x" } }))).status).toBe(401)
	})

	it("creates, lists, filters, reads and deletes templates, for every principal alike", async () => {
		const handle = publicCatalog()
		const created = await handle(request("POST", "/v1/templates", { body: '{"name":"T"}', headers: AUTH }))
		expect([created.status, json(created.body)]).toEqual([201, { id: "tmpl_1", name: "T" }])
		const beta = { authorization: "Bearer tok_beta" }
		expect(json((await handle(request("GET", "/v1/templates", { headers: beta }))).body)).toEqual({
			templates: [{ id: "tmpl_1", name: "T" }],
		})
		expect(json((await handle(request("GET", "/v1/templates?filter=id.eq.tmpl_1", { headers: beta }))).body)).toEqual({
			templates: [{ id: "tmpl_1", name: "T" }],
		})
		expect(json((await handle(request("GET", "/v1/templates?filter=id.eq.none"))).body)).toEqual({ templates: [] })
		expect(json((await handle(request("GET", "/v1/templates?filter=name.eq.T"))).body)).toEqual({
			templates: [{ id: "tmpl_1", name: "T" }],
		})
		expect((await handle(request("GET", "/v1/templates/tmpl_1", { headers: beta }))).status).toBe(200)
		const deleted = await handle(request("DELETE", "/v1/templates/tmpl_1"))
		expect([deleted.status, deleted.body, deleted.headers]).toEqual([204, "", {}])
		expect((await handle(request("GET", "/v1/templates/tmpl_1"))).status).toBe(404)
		expect((await handle(request("DELETE", "/v1/templates/tmpl_1"))).status).toBe(404)
	})

	it("names a template without a name with an empty one, and refuses what it does not serve", async () => {
		const handle = publicCatalog()
		expect(json((await handle(request("POST", "/v1/templates"))).body)).toEqual({ id: "tmpl_1", name: "" })
		expect((await handle(request("PUT", "/v1/templates"))).status).toBe(404)
		expect((await handle(request("PUT", "/v1/templates/tmpl_1"))).status).toBe(404)
		expect((await handle(request("GET", "/v1/other"))).status).toBe(404)
	})

	it("answers 500 to a body that is not JSON, or a path that does not decode", async () => {
		const handle = publicCatalog()
		expect((await handle(request("POST", "/v1/templates", { body: "{", headers: AUTH }))).status).toBe(500)
		expect((await handle(request("GET", "/v1/templates/%E0%A4%A"))).status).toBe(500)
	})
})
