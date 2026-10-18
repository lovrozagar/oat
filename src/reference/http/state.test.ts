import { describe, expect, it } from "vitest"
import { PRINCIPALS, TENANT_FIELD } from "./state.ts"

describe("PRINCIPALS", () => {
	it("holds two owners in two tenants, and a member and a viewer beside the first", () => {
		expect(PRINCIPALS.map(({ key, projectId, rank }) => [key, projectId, rank])).toEqual([
			["key_alpha", "proj_alpha", 2],
			["key_beta", "proj_beta", 2],
			["key_alpha_member", "proj_alpha", 1],
			["key_alpha_viewer", "proj_alpha", 0],
		])
		expect(new Set(PRINCIPALS.map((principal) => principal.token)).size).toBe(4)
	})

	it("names the tenant by the project field", () => {
		expect(TENANT_FIELD).toBe("project_id")
	})
})
