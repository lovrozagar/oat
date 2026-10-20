import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"

/** The reference's bearer token: what `auth.token` issues for the principal's key. */
export const SECURITY: SecurityConfig = {
	bearer: {
		login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] },
	},
}

/** Two tenants' owners, then the first tenant's member and viewer; alpha comes first, so it acts. */
export const PRINCIPALS: PrincipalsConfig = {
	alpha: { key: "key_alpha", rank: 2, scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" },
	beta: { inviteAs: "key_beta", key: "key_beta", rank: 2, scope: { project_id: "proj_beta" }, tenant: "proj_beta" },
	alpha_member: { key: "key_alpha_member", rank: 1, scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" },
	alpha_viewer: { key: "key_alpha_viewer", rank: 0, scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" },
}
