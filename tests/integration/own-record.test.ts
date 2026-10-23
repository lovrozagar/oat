import { afterEach, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"
import { run } from "../../src/runtime/run/index.ts"
import { SAFE } from "../../src/spec/methods.ts"

/*
 * A run never changes how its principal signs in. The reference's `account.update` (PUT
 * /v1/me/account, untagged) sets the caller's own email and password; alpha signs in with exactly
 * those, so a run that sent generated ones there would lock alpha out of every later run.
 */

let reference: ReferenceServer | undefined
afterEach(async () => {
	await reference?.close()
	reference = undefined
})

const ALPHA = { email: "alpha@reference.test", password: "alpha-password" }
const SIGN_IN = ["email", "password"]

/* Whether a body carries any of `keys`, deep through plain objects. */
function carries(body: unknown, keys: readonly string[]): boolean {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return false
	return Object.entries(body).some(([key, value]) => keys.includes(key) || carries(value, keys))
}

describe("the principal's own record", () => {
	it("keeps the email and password alpha signs in with, and still grades the account update", async () => {
		reference = await createMemoryServer()
		const { url } = reference
		const result = await run({
			baseUrl: url,
			principals: { alpha: ALPHA },
			security: {
				jwt: {
					login: {
						/* Its project bound from the answer: every entity's checks run, and write. */
						claims: { "scope.project_id": "$.project_id", tenant: "$.project_id" },
						from: "$.access_token",
						steps: [
							{ body: { email: "{principal.email}", password: "{principal.password}" }, operationId: "auth.login" },
						],
					},
				},
			},
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})

		const login = await fetch(`${url}/v1/auth/login`, {
			body: JSON.stringify(ALPHA),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(login.status).toBe(200)

		/* No write the run sent as alpha, its sign-ins aside, carried either field to alpha's own routes. */
		const changed = result.client.transcript.filter(
			(exchange) =>
				exchange.operationId !== "auth.login" &&
				!SAFE.has(exchange.method) &&
				new URL(exchange.url).pathname.startsWith("/v1/me") &&
				carries(exchange.requestBody, SIGN_IN),
		)
		expect(changed.map((exchange) => [exchange.principal, exchange.operationId, exchange.requestBody])).toEqual([])

		/* The floor still sent the update, without the fields alpha signs in by. */
		const update = result.client.transcript.filter((exchange) => exchange.operationId === "account.update")
		expect(update.length).toBeGreaterThan(0)
		expect(result.scope.operations.find((op) => op.operationId === "account.update")?.status).toBe("passed")
	})
})
