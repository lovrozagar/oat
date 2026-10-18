import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { userBackend, userSpec } from "./users.ts"

function ask(method: string, path: string, options: { body?: string; headers?: Record<string, string> } = {}) {
	const { body = "", headers = {} } = options
	return referenceRequest(method, new URL(path, "http://users.test"), { headers, read: async () => body })
}

describe("userBackend", () => {
	it("serves its spec and logs in", async () => {
		const { handle } = userBackend()
		expect(JSON.parse((await handle(ask("GET", "/v1/openapi/spec"))).body)).toEqual(userSpec())
		expect(JSON.parse((await handle(ask("POST", "/v1/auth/login"))).body)).toEqual({ access_token: "tok" })
	})

	it("records whether each register came from the auth steps", async () => {
		const backend = userBackend()
		const auth = { body: '{"email":"a@x.test"}', headers: { "x-via": "auth" } }
		const made = await backend.handle(ask("POST", "/v1/auth/register", auth))
		expect([made.status, JSON.parse(made.body)]).toEqual([201, { email: "a@x.test", id: "u1" }])
		expect((await backend.handle(ask("POST", "/v1/auth/register", { body: '{"email":"junk"}' }))).status).toBe(400)
		expect(JSON.parse((await backend.handle(ask("POST", "/v1/auth/register"))).body)).toEqual({ id: "u1" })
		expect(backend.registerFrom).toEqual(["auth", "other", "other"])
	})

	it("answers 404 off its routes and a bare 500 on a body it cannot parse", async () => {
		const { handle } = userBackend()
		expect((await handle(ask("GET", "/v1/users"))).status).toBe(404)
		expect((await handle(ask("POST", "/v1/auth/register", { body: "{" }))).status).toBe(500)
	})
})
