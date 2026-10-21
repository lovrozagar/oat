import type { SecurityConfig } from "../../src/config/types/security.ts"

/*
 * The reference's credentials for a test that needs only one: a principal signs in at `auth.token`
 * with its key and sends the jwt it gets back. No refresh and no apiKey to mint, so a test about
 * something else calls no credential operation beyond the sign-in.
 */

/** The reference's jwt sign-in alone: `{principal.key}` for an access token at `auth.token`. */
export const JWT_LOGIN: SecurityConfig = {
	jwt: {
		login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] },
	},
}

/** An access token the reference at `url` issues for `key`, signed in outside any run. */
export async function referenceToken(url: string, key: string): Promise<string> {
	const response = await fetch(`${url}/v1/auth/token`, {
		body: JSON.stringify({ key }),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
	if (response.status !== 200) throw new Error(`the reference refused ${key}: ${response.status}`)
	return ((await response.json()) as { access_token: string }).access_token
}
