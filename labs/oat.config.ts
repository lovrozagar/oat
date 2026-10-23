/**
 * Points oat at whichever labs world is listening.
 *
 *   LAB_URL=http://127.0.0.1:8791 node dist/cli.js run --config labs/oat.config.ts
 */

import { defineConfig } from "../dist/index.js"

const API = process.env["LAB_URL"] ?? "http://127.0.0.1:8788"

export default defineConfig({
	baseUrl: API,
	/* An owner, member and viewer in one org, and an owner in another. */
	principals: {
		alpha: { key: "key_alpha", rank: 2, scope: { org_id: "org_alpha" }, tenant: "org_alpha" },
		alpha_member: { key: "key_alpha_member", rank: 1, scope: { org_id: "org_alpha" }, tenant: "org_alpha" },
		alpha_viewer: { key: "key_alpha_viewer", rank: 0, scope: { org_id: "org_alpha" }, tenant: "org_alpha" },
		beta: { inviteAs: "key_beta", key: "key_beta", rank: 2, scope: { org_id: "org_beta" }, tenant: "org_beta" },
	},
	cohortSize: Number(process.env["COHORT"] ?? 12) || 12,
	/* The world's bearer scheme: each principal trades its key at auth.token for the token. */
	security: {
		bearer: {
			login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] },
		},
	},
	seed: 42,
	spec: `${API}/v1/openapi/spec`,
})
