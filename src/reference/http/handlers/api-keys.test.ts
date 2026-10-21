import { describe, expect, it } from "vitest"
import { api, BETA, TABLES, VIEWER } from "../__fixtures__/api.ts"

const KEYS = "/v1/api-keys"

describe("apiKey.create", () => {
	it("mints a key bound to the caller's tenant and scopes, which then reads and writes within them", async () => {
		const { call } = await api()
		const minted = await call("POST", KEYS, { body: { scopes: ["table:read", "table:write"] } })
		expect(minted.status).toBe(201)
		expect(minted.body).toEqual({ id: "apikey_000004", key: expect.stringMatching(/^ak_[0-9a-f]{32}$/) })
		const as = { headers: { authorization: `ApiKey ${String(minted.body.key)}` }, token: null }
		expect((await call("GET", TABLES, as)).status).toBe(200)
		expect((await call("POST", TABLES, { ...as, body: { name: "by key" } })).status).toBe(201)
		expect((await call("GET", "/v1/projects/proj_beta/tables", as)).status).toBe(403)
		expect((await call("GET", "/v1/me", as)).status).toBe(401)
	})

	it("keeps the creator's rank: a viewer's key with a write scope still cannot write", async () => {
		const { call } = await api()
		const minted = await call("POST", KEYS, { body: { scopes: ["table:write"] }, token: VIEWER })
		const as = { body: { name: "x" }, headers: { authorization: `ApiKey ${String(minted.body.key)}` }, token: null }
		expect((await call("POST", TABLES, as)).status).toBe(403)
	})

	it("refuses a scope the server does not know, a body of another shape, and a caller with no JWT", async () => {
		const { call } = await api()
		expect((await call("POST", KEYS, { body: { scopes: ["table:delete"] } })).status).toBe(400)
		expect((await call("POST", KEYS, { body: { scopes: "table:read" } })).status).toBe(400)
		expect((await call("POST", KEYS, { body: { scopes: [] }, token: null })).status).toBe(401)
		expect((await call("POST", KEYS, { body: { scopes: [] } })).status).toBe(201)
	})
})

describe("apiKey.revoke", () => {
	it("revokes a key of the caller's tenant, after which it is refused; another tenant's is a 404", async () => {
		const { call } = await api()
		const minted = (await call("POST", KEYS, { body: { scopes: ["table:read"] } })).body
		const as = { headers: { authorization: `ApiKey ${String(minted.key)}` }, token: null }
		expect((await call("DELETE", `${KEYS}/${String(minted.id)}`, { token: BETA })).status).toBe(404)
		expect(await call("DELETE", `${KEYS}/${String(minted.id)}`)).toMatchObject({ body: { revoked: true }, status: 200 })
		expect((await call("GET", TABLES, as)).status).toBe(401)
		expect((await call("GET", `${KEYS}/${String(minted.id)}`)).status).toBe(404)
		expect((await call("DELETE", `${KEYS}/${String(minted.id)}`)).status).toBe(404)
	})
})

describe("apiKey.get", () => {
	it("reads a live key of the caller's tenant without its value; another tenant's, or none, is a 404", async () => {
		const { call } = await api()
		const minted = (await call("POST", KEYS, { body: { scopes: ["table:read"] } })).body
		const at = `${KEYS}/${String(minted.id)}`
		expect(await call("GET", at)).toMatchObject({
			body: { id: minted.id, scopes: ["table:read"] },
			status: 200,
		})
		expect(JSON.stringify((await call("GET", at)).body)).not.toContain(String(minted.key))
		expect((await call("GET", at, { token: BETA })).status).toBe(404)
		expect((await call("GET", `${KEYS}/apikey_999999`)).status).toBe(404)
		expect((await call("GET", at, { token: null })).status).toBe(401)
	})
})
