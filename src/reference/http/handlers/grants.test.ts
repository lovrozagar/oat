import { describe, expect, it } from "vitest"
import { api, BETA, MEMBER, TABLES, VIEWER } from "../__fixtures__/api.ts"

/* Alpha's table, an invite for beta to it, and the paths that name both. */
async function shared(options = {}) {
	const world = await api(options)
	const table = await world.table("shared")
	const item = `${TABLES}/${String(table["id"])}`
	const invited = await world.call("POST", `${item}/invites`, { body: { key: "key_beta" } })
	return { ...world, invited, item, table }
}

describe("inviting a principal to a table", () => {
	it("answers a grant and its token, which the invitee accepts to read the table", async () => {
		const { call, invited, item } = await shared()
		expect(invited.status).toBe(201)
		expect(invited.body).toEqual({ grant_id: expect.stringMatching(/^grn_/), token: expect.stringMatching(/^inv_/) })
		expect((await call("GET", item, { token: BETA })).status).toBe(404)
		const accepted = await call("POST", `/v1/invites/${String(invited.body["token"])}/accept`, { token: BETA })
		expect(accepted).toMatchObject({ body: { accepted: true }, status: 200 })
		expect((await call("GET", item, { token: BETA })).body).toMatchObject({ name: "shared" })
	})

	it("refuses another tenant, a viewer, a body that is not JSON, and a missing or unknown key", async () => {
		const { call, item, table } = await shared()
		const invites = `${item}/invites`
		expect((await call("POST", invites, { body: { key: "key_beta" }, token: BETA })).status).toBe(403)
		expect((await call("POST", invites, { body: { key: "key_beta" }, token: VIEWER })).status).toBe(403)
		expect((await call("POST", invites, { form: "key=key_beta" })).status).toBe(415)
		expect((await call("POST", invites, { body: {} })).status).toBe(400)
		expect((await call("POST", invites, { body: { key: "key_nobody" } })).body["message"]).toBe("unknown invitee key")
		expect((await call("POST", `${TABLES}/missing/invites`, { body: { key: "key_beta" } })).status).toBe(404)
		expect((await call("GET", invites)).status).toBe(404)
		expect(table["id"]).toBeDefined()
	})

	it("names the table by its slug under tenant slugs", async () => {
		const { call } = await api({ shape: "tenant-slugs" })
		await call("POST", TABLES, { body: { name: "Shared Plan" } })
		expect((await call("POST", `${TABLES}/shared-plan/invites`, { body: { key: "key_beta" } })).status).toBe(201)
	})
})

describe("accepting an invite", () => {
	it("refuses an unknown token with a 404, and another principal with a 403", async () => {
		const { call, invited } = await shared()
		expect((await call("POST", "/v1/invites/inv_nope/accept", { token: BETA })).status).toBe(404)
		expect((await call("POST", `/v1/invites/${String(invited.body["token"])}/accept`)).status).toBe(403)
		expect((await call("POST", "/v1/invites/x/accept", { token: null })).status).toBe(401)
		expect((await call("GET", `/v1/invites/${String(invited.body["token"])}/accept`)).status).toBe(404)
	})
})

describe("revoking a grant", () => {
	it("withdraws the invitee's access", async () => {
		const { call, invited, item } = await shared()
		await call("POST", `/v1/invites/${String(invited.body["token"])}/accept`, { token: BETA })
		const revoked = await call("DELETE", `${item}/grants/${String(invited.body["grant_id"])}`)
		expect(revoked).toMatchObject({ body: { revoked: true }, status: 200 })
		expect((await call("GET", item, { token: BETA })).status).toBe(404)
	})

	it("keeps the grant under REVOKE_IGNORED", async () => {
		const { call, invited, item } = await shared({ defects: ["REVOKE_IGNORED"] })
		await call("POST", `/v1/invites/${String(invited.body["token"])}/accept`, { token: BETA })
		expect((await call("DELETE", `${item}/grants/${String(invited.body["grant_id"])}`)).status).toBe(200)
		expect((await call("GET", item, { token: BETA })).status).toBe(200)
	})

	it("refuses another tenant, a member, an unknown grant and another table's grant", async () => {
		const { call, invited, item, table } = await shared()
		const grant = `${item}/grants/${String(invited.body["grant_id"])}`
		expect((await call("DELETE", grant, { token: BETA })).status).toBe(403)
		expect((await call("DELETE", grant, { token: MEMBER })).status).toBe(403)
		expect((await call("DELETE", `${item}/grants/grn_nope`)).status).toBe(404)
		const other = await call("POST", TABLES, { body: { name: "other" } })
		const elsewhere = `${TABLES}/${String(other.body["id"])}/grants/${String(invited.body["grant_id"])}`
		expect((await call("DELETE", elsewhere)).body["message"]).toBe("grant not found")
		expect((await call("GET", grant)).status).toBe(404)
		expect(table["id"]).toBeDefined()
	})
})
