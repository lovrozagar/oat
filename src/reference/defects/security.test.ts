import { describe, expect, it } from "vitest"
import { SECURITY_DEFECTS } from "./security.ts"

describe("SECURITY_DEFECTS", () => {
	it("holds the family of credentials, schemes, scopes, sessions, roles and logins, in the table's order", () => {
		expect(Object.keys(SECURITY_DEFECTS)).toEqual([
			"AUTH_IGNORED_ON_ROUTE",
			"TOKEN_NOT_VERIFIED",
			"ANY_SCHEME_ACCEPTED",
			"SCOPE_NOT_CHECKED",
			"APIKEY_ALTERNATIVE_BROKEN",
			"PUBLIC_ROUTE_GUARDED",
			"REVOKED_TOKEN_ACCEPTED",
			"REFRESH_REUSE_ACCEPTED",
			"ROLE_NOT_CHECKED",
			"CROSS_TENANT_KEY_ACCEPTED",
			"PRIVILEGED_FIELD_WRITABLE",
			"LOGIN_NOT_THROTTLED",
		])
	})

	it("names each defect in upper snake case and describes it in one clause", () => {
		for (const [name, description] of Object.entries(SECURITY_DEFECTS)) {
			expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
			expect(description.trim()).toBe(description)
			expect(description.length).toBeGreaterThan(10)
			expect(description).not.toMatch(/\.$/)
		}
	})
})
