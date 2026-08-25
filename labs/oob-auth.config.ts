/**
 * A config against a live API that needs a multi-step login.
 *
 * This file is the entire coupling surface between oat and one specific backend: which route
 * issues a credential, how a verification *link* that never travels over HTTP is collected, which
 * header carries it, and which path parameters the credential itself identifies. Delete it and
 * oat still runs against any other OpenAPI document.
 *
 * The primary chain is the user-visible hop: the mailbox returns a URL, oat GETs it (recorded),
 * and `saveAs` binds cookies. APIs whose user path is POST-token keep that spelling — see the
 * comment on `signUpPostToken` below.
 *
 *   OAT_API_URL=... OAT_TESTER_KEY=... oat run --config labs/oob-auth.config.ts
 *
 * Written as `from "../dist/index.js"` only because this file lives inside the repository —
 * in your own project it is `from "@lovrozagar/oat"`.
 */

import { defineConfig, type AuthFlow, type OutOfBandRequest, type TeardownPrincipalContext } from "../dist/index.js"

const API = process.env.OAT_API_URL ?? "https://api.example.com"
const APP = process.env.OAT_APP_URL ?? "https://app.example.com"
const TESTER_KEY = process.env.OAT_TESTER_KEY ?? ""
const PASSWORD = "OatSpec123!x"

/** A distinct address per principal per run, so tenants never collide between runs. */
function freshEmail(label: string): string {
	return `oat-${label}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@oat-spec.test`
}

/**
 * Register, collect the emailed verification link, GET it, keep the session cookie.
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
		header: "cookie",
		template: "session={credential}",
		refresh: {
			steps: [
				{
					body: { refresh_token: "{refreshToken}" },
					method: "POST",
					path: "/v1/auth/refresh",
					saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
				},
			],
		},
		steps: [
			/* Raw paths rather than operationIds: an API document like this commonly contains no
			 * auth operations at all, so there is nothing in the spec to reference. `oat doctor`
			 * reports that as a gap — a document describing a protected API should describe how
			 * to authenticate to it. */
			{
				/* Binding the address is what lets teardown cascade the account away afterwards. */
				bind: { address: email },
				body: { email, name: `Oat ${label}`, password: PASSWORD },
				method: "POST",
				path: "/v1/auth/register/email",
				saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
			},
			{ outOfBand: { address: email, as: "verifyLink", kind: "email-verify" } },
			{
				expect: [200, 303],
				method: "GET",
				path: "{verifyLink}",
				saveAs: {
					credential: "cookie:session",
					refreshToken: "cookie:refresh",
				},
				saveClaimsFrom: {
					bind: { orgId: "orgs.0.oid", projectId: "orgs.0.pids.0" },
					token: "credential",
				},
			},
		],
	}
}

/*
 * Token string → POST verify. Valid when that POST *is* the user path. Do not use it to
 * stand in for a mailed GET the human actually clicks.
 *
 *   { outOfBand: { address: email, as: "verifyToken", kind: "email-verify" } },
 *   {
 *     body: { token: "{verifyToken}" },
 *     method: "POST",
 *     path: "/v1/auth/email/verify",
 *     saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
 *     saveClaimsFrom: { token: "$.access_token", bind: { orgId: "orgs.0.oid", projectId: "orgs.0.pids.0" } },
 *   }
 */

/**
 * Reads a link this deployment stashes for test traffic. Every backend does this differently —
 * a mail catcher, a KV tap, a webhook sink — which is exactly why oat cannot do it for you.
 * Returning null asks oat to retry: such stores are usually eventually consistent.
 * `scope` / `headers` are the live principal (the register JWT) so a click-while-signed-in
 * hook can send the session the human would have. The GET of the returned URL is a later
 * RequestStep, not this hook.
 */
async function resolveOutOfBand({ address, kind, scope }: OutOfBandRequest): Promise<string | null> {
	const url = new URL(`${API}/v1/test/last-token`)
	url.searchParams.set("email", address)
	url.searchParams.set("type", kind)
	const headers: Record<string, string> = { "x-oat-tester-key": TESTER_KEY }
	if (scope.credential !== undefined && scope.credential !== "") {
		headers.authorization = `Bearer ${scope.credential}`
	}
	const response = await fetch(url, { headers })
	if (!response.ok) return null
	const body = (await response.json()) as { link?: unknown; token?: unknown }
	if (typeof body.link === "string" && body.link !== "") return body.link
	/* Some stashes still return a bare token — compose the consume URL the human would click. */
	if (typeof body.token === "string" && body.token !== "") {
		const consume = new URL("/verify", APP)
		consume.searchParams.set("token", body.token)
		return consume.toString()
	}
	return null
}

/** Authenticated delete of the current principal — no tester-key god route. */
async function teardownPrincipal(_address: string, { headers }: TeardownPrincipalContext): Promise<void> {
	await fetch(`${API}/v1/auth/account`, { headers, method: "DELETE" })
}

export default defineConfig({
	baseUrl: API,
	/* Sent on every request. Opaque to oat — it never inspects these. */
	globalHeaders: { "x-oat-tester-key": TESTER_KEY },
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
