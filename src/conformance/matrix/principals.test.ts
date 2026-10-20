import { describe, expect, it } from "vitest"
import { PRINCIPALS, SECURITY } from "./principals.ts"

describe("PRINCIPALS", () => {
	it("are two tenants' owners and the first tenant's lower ranks, each with its own key", () => {
		expect(
			Object.entries(PRINCIPALS).map(([id, p]) => [id, p.key, p.rank, p.tenant, p.scope?.project_id, p.inviteAs]),
		).toEqual([
			["alpha", "key_alpha", 2, "proj_alpha", "proj_alpha", undefined],
			["beta", "key_beta", 2, "proj_beta", "proj_beta", "key_beta"],
			["alpha_member", "key_alpha_member", 1, "proj_alpha", "proj_alpha", undefined],
			["alpha_viewer", "key_alpha_viewer", 0, "proj_alpha", "proj_alpha", undefined],
		])
	})
})

describe("SECURITY", () => {
	it("signs each principal in by trading its key at auth.token for the bearer token", () => {
		expect(SECURITY).toEqual({
			bearer: {
				login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] },
			},
		})
	})
})
