import { describe, expect, it } from "vitest"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import { answerOf, BEARER, ctxOf, fakePorts, NOW, rejection } from "../__fixtures__/ports.ts"
import { acquireOAuth2 } from "./oauth2.ts"

const OAUTH: SecurityScheme = {
	deprecated: false,
	flows: {
		clientCredentials: { scopes: ["rows:read", "rows:write"], tokenUrl: "https://id.x.io/token" },
		password: { scopes: [], tokenUrl: "/oauth/token" },
	},
	kind: "oauth2",
	name: "oauth",
}
const token = (body: unknown) => () => Promise.resolve(answerOf(body))

describe("acquireOAuth2", () => {
	it("posts a client-credentials grant for the scope set, space-joined, and reads access_token", async () => {
		const { ports, recorded } = fakePorts({ post: token({ access_token: "a1", expires_in: 3600 }) })
		const ctx = ctxOf(ports, { scheme: OAUTH, scopes: ["rows:read", "rows:write"] })
		const issued = await acquireOAuth2(ctx, { clientId: "cid", clientSecret: "sec", flow: "clientCredentials" }, {})
		expect([issued.value, issued.expiresAt, issued.scopes]).toEqual([
			"a1",
			NOW + 3_600_000,
			["rows:read", "rows:write"],
		])
		expect(recorded.posts).toEqual([
			{
				form: {
					client_id: "cid",
					client_secret: "sec",
					grant_type: "client_credentials",
					scope: "rows:read rows:write",
				},
				url: "https://id.x.io/token",
			},
		])
	})

	it("posts a password grant with the principal's credentials and the recipe's scopes when the operation asks none", async () => {
		const { ports, recorded } = fakePorts({ post: token({ access_token: "a2" }) })
		const recipe = {
			clientId: "cid",
			flow: "password" as const,
			password: "{principal.password}",
			scopes: ["openid"],
			username: "{principal.email}",
		}
		const issued = await acquireOAuth2(ctxOf(ports, { scheme: OAUTH }), recipe, { expiresIn: 60 })
		expect([issued.value, issued.expiresAt, issued.scopes]).toEqual(["a2", NOW + 60_000, ["openid"]])
		expect(recorded.posts[0]).toEqual({
			form: { client_id: "cid", grant_type: "password", password: "pw", scope: "openid", username: "ann@x.io" },
			url: "/oauth/token",
		})
	})

	it("sends no scope when neither the operation nor the recipe names one", async () => {
		const { ports, recorded } = fakePorts({ post: token({ access_token: "a3" }) })
		const issued = await acquireOAuth2(
			ctxOf(ports, { scheme: OAUTH }),
			{ clientId: "c", flow: "clientCredentials" },
			{},
		)
		expect([issued.scopes, recorded.posts[0]?.form]).toEqual([[], { client_id: "c", grant_type: "client_credentials" }])
	})
})

describe("acquireOAuth2: renewal", () => {
	it("renews by the refresh_token grant with the same client and scope, carrying a rotated token forward", async () => {
		const answers = [
			answerOf({ access_token: "a1", refresh_token: "r1" }),
			answerOf({ access_token: "a2", refresh_token: "r2" }),
			answerOf({ access_token: "a3" }),
			answerOf({ access_token: "a4" }),
		]
		const { ports, recorded } = fakePorts({ post: () => Promise.resolve(answers.shift() ?? answerOf({}, 400)) })
		const ctx = ctxOf(ports, { scheme: OAUTH, scopes: ["rows:read"] })
		const first = await acquireOAuth2(ctx, { clientId: "cid", clientSecret: "sec", flow: "clientCredentials" }, {})
		const values = [first.value]
		let held = first
		for (let renewals = 0; renewals < 3; renewals++) {
			held = await (held.refresh as () => Promise<typeof held>)()
			values.push(held.value)
		}
		const refreshed = { client_id: "cid", client_secret: "sec", grant_type: "refresh_token", scope: "rows:read" }
		expect([values, recorded.posts.slice(1).map((post) => post.form)]).toEqual([
			["a1", "a2", "a3", "a4"],
			[
				{ ...refreshed, refresh_token: "r1" },
				{ ...refreshed, refresh_token: "r2" },
				{ ...refreshed, refresh_token: "r2" },
			],
		])
		expect(recorded.posts.map((post) => post.url)).toEqual(Array.from({ length: 4 }, () => "https://id.x.io/token"))
	})

	it("has no refresh of its own without a refresh_token, so the store runs the grant again", async () => {
		const { ports } = fakePorts({ post: token({ access_token: "a1" }) })
		const issued = await acquireOAuth2(
			ctxOf(ports, { scheme: OAUTH }),
			{ clientId: "c", flow: "clientCredentials" },
			{},
		)
		expect(issued.refresh).toBeUndefined()
	})
})

describe("acquireOAuth2: a form answer", () => {
	it("reads the access token, its lifetime and the refresh token it renews by from a form answer", async () => {
		const headers = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
		const form = { ...answerOf("access_token=a-form&refresh_token=r-form&expires_in=3600"), headers }
		const { ports, recorded } = fakePorts({ post: () => Promise.resolve(form) })
		const issued = await acquireOAuth2(
			ctxOf(ports, { scheme: OAUTH }),
			{ clientId: "c", flow: "clientCredentials" },
			{},
		)
		expect([issued.value, issued.expiresAt]).toEqual(["a-form", NOW + 3_600_000])
		await issued.refresh?.()
		expect(recorded.posts[1]?.form).toEqual({ client_id: "c", grant_type: "refresh_token", refresh_token: "r-form" })
	})
})

describe("acquireOAuth2: failures", () => {
	it("fails with the reason on a refused grant or an answer with no access_token", async () => {
		const answers = [answerOf({ error: "invalid_client" }, 401), answerOf({ token_type: "bearer" })]
		const { ports } = fakePorts({ post: () => Promise.resolve(answers.shift() ?? answerOf({})) })
		const ctx = ctxOf(ports, { scheme: OAUTH })
		const recipe = { clientId: "c", flow: "clientCredentials" as const }
		expect((await rejection(acquireOAuth2(ctx, recipe, {}))).message).toBe("oauth2 token request answered 401")
		expect((await rejection(acquireOAuth2(ctx, recipe, {}))).message).toBe(
			"oauth2 token request answered no credential at $.access_token (its answer names no content type)",
		)
	})

	it("refuses a scheme that declares no token URL for the flow", async () => {
		const { ports, recorded } = fakePorts()
		const recipe = { clientId: "c", flow: "password" as const }
		const noFlow: SecurityScheme = { ...OAUTH, flows: {} }
		for (const scheme of [BEARER, noFlow]) {
			expect((await rejection(acquireOAuth2(ctxOf(ports, { scheme }), recipe, {}))).message).toBe(
				`the "${scheme.name}" scheme declares no tokenUrl for the password flow`,
			)
		}
		expect(recorded.posts).toEqual([])
	})
})
