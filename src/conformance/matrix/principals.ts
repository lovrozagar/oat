import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"

/**
 * The reference's schemes: the jwt is what `auth.token` issues for the principal's key, rotated at
 * `auth.refresh` with the refresh token each answer carries, and ended at `auth.logout`; the apiKey
 * is minted with that jwt, holding the scopes the operation needs, revoked when the run is done, and
 * sent as `ApiKey <key>`.
 */
export const SECURITY: SecurityConfig = {
	apiKey: {
		format: "ApiKey {credential}",
		mint: {
			body: { scopes: "{scopes}" },
			from: "$.key",
			operationId: "apiKey.create",
			revoke: "apiKey.revoke",
			with: "jwt",
		},
	},
	jwt: {
		login: {
			from: "$.access_token",
			revoke: "auth.logout",
			steps: [
				{ body: { key: "{principal.key}" }, operationId: "auth.token", saveAs: { refresh_token: "$.refresh_token" } },
			],
		},
		refresh: {
			from: "$.access_token",
			steps: [
				{
					body: { refresh_token: "{refresh_token}" },
					operationId: "auth.refresh",
					saveAs: { refresh_token: "$.refresh_token" },
				},
			],
		},
	},
}

/** Two tenants' owners, then the first tenant's member and its read-only viewer; alpha comes first, so it acts. */
export const PRINCIPALS: PrincipalsConfig = {
	alpha: { key: "key_alpha", rank: 2, scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" },
	beta: { inviteAs: "key_beta", key: "key_beta", rank: 2, scope: { project_id: "proj_beta" }, tenant: "proj_beta" },
	alpha_member: { key: "key_alpha_member", rank: 1, scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" },
	alpha_viewer: {
		key: "key_alpha_viewer",
		rank: 0,
		readOnly: true,
		scope: { project_id: "proj_alpha" },
		tenant: "proj_alpha",
	},
}
