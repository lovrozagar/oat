/**
 * A config against a live API that needs a multi-step login.
 *
 * This file is the entire coupling surface between oat and one specific backend: which route
 * issues a credential, how a verification token that never travels over HTTP is collected, which
 * header carries it, and which path parameters the credential itself identifies. Delete it and
 * oat still runs against any other OpenAPI document.
 *
 *   ANYROW_TESTER_KEY=... oat run --config labs/anyrow.config.ts
 *
 * Written as `from "../dist/index.js"` only because this file lives inside the repository —
 * in your own project it is `from "@lovrozagar/oat"`.
 */

import { defineConfig, type AuthFlow, type OutOfBandRequest } from "../dist/index.js"

const API = process.env.ANYROW_API ?? "https://api.anyrow.ai"
const TESTER_KEY = process.env.ANYROW_TESTER_KEY ?? ""
const PASSWORD = "OatSpec123!x"

/** A distinct address per principal per run, so tenants never collide between runs. */
function freshEmail(label: string): string {
	return `oat-${label}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@anyrow-spec.test`
}

/**
 * Register, collect the emailed verification token, verify, keep the credential.
 *
 * Registration provisions an organisation and a project, so each principal arrives owning its
 * own tenant — which is what makes the isolation checks meaningful without a single fixture
 * identifier being configured by hand.
 */
function signUp(label: string): AuthFlow {
	const email = freshEmail(label)
	return {
		credentialFrom: "$.access_token",
		expiresInFrom: "$.access_token_expires_in",
		steps: [
			/* Raw paths rather than operationIds: this API's published document contains no auth
			 * operations at all, so there is nothing in the spec to reference. `oat doctor`
			 * reports that as a gap — a document describing a protected API should describe how
			 * to authenticate to it. */
			{
				/* Binding the address is what lets teardown cascade the account away afterwards. */
				bind: { address: email },
				body: { email, name: `Oat ${label}`, password: PASSWORD },
				method: "POST",
				path: "/v1/auth/register/email",
			},
			{ outOfBand: { address: email, as: "verifyToken", kind: "email-verify" } },
			{
				body: { token: "{verifyToken}" },
				method: "POST",
				path: "/v1/auth/email/verify",
				saveAs: { credential: "$.access_token" },
				/* The credential names the org and project registration just provisioned. */
				saveClaimsFrom: {
					bind: { orgId: "orgs.0.oid", projectId: "orgs.0.pids.0" },
					token: "$.access_token",
				},
			},
		],
	}
}

/**
 * Reads a token this deployment stashes for test traffic. Every backend does this differently —
 * a mail catcher, a KV tap, a webhook sink — which is exactly why oat cannot do it for you.
 * Returning null asks oat to retry: such stores are usually eventually consistent.
 */
async function resolveOutOfBand({ address, kind }: OutOfBandRequest): Promise<string | null> {
	const url = new URL(`${API}/v1/test/last-token`)
	url.searchParams.set("email", address)
	url.searchParams.set("type", kind)
	const response = await fetch(url, { headers: { "x-ia-tester-key": TESTER_KEY } })
	if (!response.ok) return null
	const body = (await response.json()) as { token?: unknown }
	return typeof body.token === "string" ? body.token : null
}

/** Cascade-deletes a principal this run provisioned, and everything it created with it. */
async function teardownPrincipal(address: string): Promise<void> {
	const url = new URL(`${API}/v1/test/cleanup-user`)
	url.searchParams.set("email", address)
	await fetch(url, { headers: { "x-ia-tester-key": TESTER_KEY }, method: "DELETE" })
}

export default defineConfig({
	baseUrl: API,
	/* Sent on every request. Opaque to oat — it never inspects these. */
	globalHeaders: { "x-ia-tester-key": TESTER_KEY },
	hooks: { resolveOutOfBand, teardownPrincipal },
	principals: [
		{
			auth: signUp("alpha"),
			id: "alpha",
			rootsFromFlow: { organization_id: "orgId", project_id: "projectId" },
		},
		{
			auth: signUp("beta"),
			id: "beta",
			rootsFromFlow: { organization_id: "orgId", project_id: "projectId" },
		},
	],
	seed: 42,
	spec: `${API}/v1/openapi/spec`,
})
