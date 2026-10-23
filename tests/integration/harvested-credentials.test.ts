import { afterEach, describe, expect, it } from "vitest"
import type { SecurityConfig } from "../../src/config/types/security.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"
import { run } from "../../src/runtime/run/index.ts"
import { sentTo, wireLog } from "../support/wire-log.ts"

/*
 * A credential harvested from sign-in answers: one step saves the refresh token the reference
 * answered, the next spends it, and the credential is the last answer's access token. The token's
 * claim names alpha's tenant and the answer body's `project_id` its project, so a principal
 * configured with only its key reaches its project's records.
 */

let reference: ReferenceServer | undefined
afterEach(async () => {
	await reference?.close()
	reference = undefined
})

const HARVEST: SecurityConfig = {
	jwt: {
		login: {
			claims: { "scope.project_id": "$.project_id", tenant: "project_id" },
			from: "$.access_token",
			steps: [
				{ body: { key: "{principal.key}" }, operationId: "auth.token", saveAs: { refresh_token: "$.refresh_token" } },
				{ body: { refresh_token: "{refresh_token}" }, operationId: "auth.refresh" },
			],
		},
	},
}

/* The JSON answer of each logged request to `path` that the reference took. */
function answers<T>(log: ReturnType<typeof wireLog>, path: string): T[] {
	return log.entries
		.filter((entry) => entry.path === path && entry.status === 200)
		.map((e) => JSON.parse(e.answer) as T)
}

describe("a harvested credential", () => {
	it("carries a saved value into the next step, sends the last answer's token, and binds the claims", async () => {
		reference = await createMemoryServer()
		const { url } = reference
		const log = wireLog()
		const result = await run({
			baseUrl: url,
			network: { fetch: log.fetch },
			ops: ["table.list"],
			principals: { alpha: { key: "key_alpha" } },
			security: HARVEST,
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})
		const [signedIn] = answers<{ access_token: string; refresh_token: string }>(log, "/v1/auth/token")
		const refreshes = log.entries.filter((entry) => entry.path === "/v1/auth/refresh")
		expect(refreshes[0]?.status).toBe(200)
		const [renewed] = answers<{ access_token: string }>(log, "/v1/auth/refresh")
		const refreshCall = result.client.transcript.find((exchange) => exchange.operationId === "auth.refresh")
		expect(refreshCall?.requestBody).toEqual({ refresh_token: signedIn?.refresh_token })

		expect(result.scope.operations.find((op) => op.operationId === "table.list")?.status).toBe("passed")
		const sent = sentTo(log, "/v1/projects/proj_alpha/tables")
		expect(sent).toContain(`Bearer ${renewed?.access_token}`)
		expect(sent).not.toContain(`Bearer ${signedIn?.access_token}`)
		expect(result.principals.find((principal) => principal.id === "alpha")).toMatchObject({
			credentials: [{ scheme: "jwt" }],
			scope: { project_id: "proj_alpha" },
			tenant: "proj_alpha",
		})
	})
})
