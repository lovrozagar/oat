/**
 * Points oat at the lab API. Same coupling surface as any other backend:
 * spec URL, auth flow, a same-tenant rank lattice, and a peer tenant.
 *
 *   node --experimental-sqlite --experimental-strip-types dist/cli.js run --config lab/oat.config.ts
 */

import { defineConfig } from "../dist/index.js"

const API = process.env.LAB_URL ?? "http://127.0.0.1:8788"

export default defineConfig({
	baseUrl: API,
	principals: [
		{
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ body: { key: "key_alpha" }, operationId: "auth.token" }],
			},
			id: "alpha",
			rank: 2,
			role: "owner",
			roots: { org_id: "org_alpha" },
		},
		{
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ body: { key: "key_alpha_member" }, operationId: "auth.token" }],
			},
			id: "alpha_member",
			rank: 1,
			role: "member",
			roots: { org_id: "org_alpha" },
		},
		{
			auth: {
				credentialFrom: "$.access_token",
				steps: [{ body: { key: "key_alpha_viewer" }, operationId: "auth.token" }],
			},
			id: "alpha_viewer",
			rank: 0,
			role: "viewer",
			roots: { org_id: "org_alpha" },
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
			roots: { org_id: "org_beta" },
		},
	],
	seed: 42,
	spec: `${API}/v1/openapi/spec`,
})
