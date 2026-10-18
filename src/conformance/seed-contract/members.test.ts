import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { memberBackend, memberSpec } from "./members.ts"

function ask(method: string, path: string, body = "") {
	return referenceRequest(method, new URL(path, "http://members.test"), { headers: {}, read: async () => body })
}

describe("memberBackend", () => {
	it("serves its spec and an empty member list", async () => {
		const { handle } = memberBackend()
		expect(JSON.parse((await handle(ask("GET", "/v1/openapi/spec"))).body)).toEqual(memberSpec())
		expect(JSON.parse((await handle(ask("GET", "/v1/orgs/org_1/members"))).body)).toEqual({ members: [] })
	})

	it("grants an invite, and refuses and records a generated non-email", async () => {
		const backend = memberBackend()
		const granted = await backend.handle(ask("POST", "/v1/orgs/org_1/members", '{"invite_email":"b@x.test"}'))
		expect([granted.status, JSON.parse(granted.body)]).toEqual([201, { grant_id: "g1", token: "tok" }])
		const junk = await backend.handle(ask("POST", "/v1/orgs/org_1/members", '{"invite_email":"Quarterly"}'))
		expect(junk.status).toBe(400)
		expect((await backend.handle(ask("POST", "/v1/orgs/org_1/members", "null"))).status).toBe(201)
		expect(backend.inviteBodies).toEqual([{ invite_email: "b@x.test" }, { invite_email: "Quarterly" }, null])
		expect(backend.seedBodies).toEqual([{ invite_email: "Quarterly" }])
	})

	it("accepts and revokes the grant, and answers 404 elsewhere", async () => {
		const { handle } = memberBackend()
		expect((await handle(ask("POST", "/v1/invites/tok/accept"))).status).toBe(200)
		expect((await handle(ask("DELETE", "/v1/orgs/org_1/grants/g1"))).status).toBe(200)
		expect((await handle(ask("GET", "/v1/orgs/org_1/members/m_1"))).status).toBe(404)
	})

	it("answers a bare 500 on a body it cannot parse", async () => {
		const { handle } = memberBackend()
		expect((await handle(ask("POST", "/v1/orgs/org_1/members", "{"))).status).toBe(500)
	})
})
