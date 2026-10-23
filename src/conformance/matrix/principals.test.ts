import { describe, expect, it } from "vitest"
import { PRINCIPALS, SECURITY } from "./principals.ts"

describe("PRINCIPALS", () => {
	it("are two tenants' owners and the first tenant's lower ranks, each with its own key", () => {
		expect(
			Object.entries(PRINCIPALS).map(([id, p]) => [
				id,
				p["key"],
				p.rank,
				p.tenant,
				p.scope?.["project_id"],
				p.inviteAs,
			]),
		).toEqual([
			["alpha", "key_alpha", 2, "proj_alpha", "proj_alpha", undefined],
			["beta", "key_beta", 2, "proj_beta", "proj_beta", "key_beta"],
			["alpha_member", "key_alpha_member", 1, "proj_alpha", "proj_alpha", undefined],
			["alpha_viewer", "key_alpha_viewer", 0, "proj_alpha", "proj_alpha", undefined],
		])
		expect(
			Object.entries(PRINCIPALS)
				.filter(([, p]) => p.readOnly === true)
				.map(([id]) => id),
		).toEqual(["alpha_viewer"])
	})
})

describe("SECURITY", () => {
	it("signs each principal in at auth.token for the jwt, rotates it, ends it at auth.logout, and mints a scoped apiKey", () => {
		expect(SECURITY).toEqual({
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
						{
							body: { key: "{principal.key}" },
							operationId: "auth.token",
							saveAs: { refresh_token: "$.refresh_token" },
						},
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
		})
	})
})
