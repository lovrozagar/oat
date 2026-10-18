import type { PrincipalSpec } from "../../runtime/run/index.ts"

export const PRINCIPALS: PrincipalSpec[] = [
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_alpha" }, operationId: "auth.token" }],
		},
		id: "alpha",
		rank: 2,
		role: "owner",
		roots: { project_id: "proj_alpha" },
	},
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_beta" }, operationId: "auth.token" }],
		},
		id: "beta",
		inviteAs: "key_beta",
		rank: 2,
		role: "owner",
		roots: { project_id: "proj_beta" },
	},
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_alpha_member" }, operationId: "auth.token" }],
		},
		id: "alpha_member",
		rank: 1,
		role: "member",
		roots: { project_id: "proj_alpha" },
	},
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_alpha_viewer" }, operationId: "auth.token" }],
		},
		id: "alpha_viewer",
		rank: 0,
		role: "viewer",
		roots: { project_id: "proj_alpha" },
	},
]
