import { afterEach, describe, expect, it } from "vitest"
import type { SecurityConfig } from "../../src/config/types/security.ts"
import { bearerSecurity } from "../../src/conformance/harness/security.ts"
import type { Exchange } from "../../src/runtime/exchange.ts"
import { run } from "../../src/runtime/run/index.ts"
import { dispatch, inviteSpec, listen, readJson, type Route, send } from "../support/invite-accept-fixtures.ts"

/*
 * An invite accept hands the delegate a credential of its own, which the run adopts. That
 * credential carries no refresh token, so when the API turns it away the delegate renews the
 * session it signed in with. An account the run created by its login is never registered again.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

/* Each principal signs in by its user, saving a refresh token the refresh reads. */
const security: SecurityConfig = {
	bearer: {
		login: {
			from: "$.access_token",
			steps: [
				{
					body: { user: "{principal.user}" },
					method: "POST",
					path: "/v1/auth/login",
					saveAs: { refresh_token: "$.refresh_token" },
				},
			],
		},
		refresh: {
			from: "$.access_token",
			steps: [{ body: { token: "{refresh_token}" }, method: "POST", path: "/v1/auth/refresh" }],
		},
	},
}

const principals = {
	alpha: { scope: { org_id: "org_1" }, tenant: "org_1", user: "a" },
	beta: { created: true, inviteAs: "beta@x.test", scope: { org_id: "org_2" }, tenant: "org_2", user: "b" },
}

/*
 * The owner is `a`. Beta's login registers it, so a second one is refused as already registered.
 * The token the accept issues has expired by its first use; beta's own session renews to `b2`.
 */
function routes(): Route[] {
	let granted = false
	const logins = new Map<string, number>()
	return [
		["GET", "/v1/openapi/spec", (_req, res) => send(res, 200, { ...inviteSpec("body"), ...bearerSecurity() })],
		[
			"POST",
			"/v1/auth/login",
			async (req, res) => {
				const user = String(((await readJson(req)) as { user?: unknown }).user)
				const count = (logins.get(user) ?? 0) + 1
				logins.set(user, count)
				if (user === "b" && count > 1) return send(res, 409, { error: "email_already_registered" })
				return send(res, 200, { access_token: user === "a" ? "a" : "b1", refresh_token: `r-${user}` })
			},
		],
		[
			"POST",
			"/v1/auth/refresh",
			async (req, res) => {
				const token = ((await readJson(req)) as { token?: unknown }).token
				if (token === "r-a") return send(res, 200, { access_token: "a" })
				return token === "r-b" ? send(res, 200, { access_token: "b2" }) : send(res, 401)
			},
		],
		[
			"GET",
			"/v1/orgs/org_1/members",
			(_req, res) => send(res, 200, { members: [{ email: "owner@x.test", id: "m1" }] }),
		],
		["POST", "/v1/orgs/org_1/members", (_req, res) => send(res, 201, { grant_id: "g1", token: "tok-from-invite" })],
		[
			"POST",
			"/v1/invites/accept",
			(_req, res) => {
				granted = true
				send(res, 200, { access_token: "issued", id: "g1" })
			},
		],
		[
			"DELETE",
			"/v1/orgs/org_1/grants/g1",
			(_req, res) => {
				granted = false
				send(res, 200, { ok: true })
			},
		],
		[
			"GET",
			"/v1/orgs/org_1/members/m1",
			(req, res) => {
				const auth = req.headers.authorization
				if (auth === "Bearer a") return send(res, 200, { email: "owner@x.test", id: "m1" })
				if (auth === "Bearer issued") return send(res, 401, { error: "token_expired" })
				return auth === "Bearer b2" && granted ? send(res, 200, { email: "beta@x.test", id: "m1" }) : send(res, 403)
			},
		],
	]
}

const sentTo = (transcript: readonly Exchange[], method: string, path: string): Exchange[] =>
	transcript.filter((exchange) => exchange.method === method && new URL(exchange.url).pathname === path)

describe("a credential an invite accept issued, once the API turns it away", () => {
	it("renews the delegate's own session, never signing a created account up again, and the request is sent", async () => {
		const table = routes()
		const server = await listen((req, res) => {
			dispatch(table, req, res).catch(() => {
				if (!res.headersSent) send(res, 500)
			})
		})
		closers.push(server.close)
		const result = await run({
			baseUrl: server.url,
			only: ["member"],
			principals,
			security,
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const { transcript } = result.client
		const betaLogins = sentTo(transcript, "POST", "/v1/auth/login").filter(
			(exchange) => (exchange.requestBody as { user?: string }).user === "b",
		)
		const reads = sentTo(transcript, "GET", "/v1/orgs/org_1/members/m1").filter(
			(exchange) => exchange.principal === "beta",
		)
		expect(betaLogins).toHaveLength(1)
		expect(sentTo(transcript, "POST", "/v1/auth/refresh").map((exchange) => exchange.requestBody)).toContainEqual({
			token: "r-b",
		})
		expect(reads.map((exchange) => [exchange.requestHeaders["Authorization"], exchange.status])).toContainEqual([
			"Bearer b2",
			200,
		])
	})
})
