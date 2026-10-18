import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "./principals.ts"

describe("PRINCIPALS", () => {
	it("are two tenants' owners and the first tenant's lower ranks, each logging in by key", () => {
		expect(PRINCIPALS.map((p) => [p.id, p.role, p.rank, p.roots?.project_id])).toEqual([
			["alpha", "owner", 2, "proj_alpha"],
			["beta", "owner", 2, "proj_beta"],
			["alpha_member", "member", 1, "proj_alpha"],
			["alpha_viewer", "viewer", 0, "proj_alpha"],
		])
		for (const principal of PRINCIPALS) {
			expect(principal.auth).toMatchObject({ credentialFrom: "$.access_token", steps: [{ operationId: "auth.token" }] })
		}
	})
})
