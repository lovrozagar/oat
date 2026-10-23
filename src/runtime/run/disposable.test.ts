import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../../config/types/security.ts"
import type { Credential } from "../../credentials/store.ts"
import { accounts, accountsApi, accountsDoc } from "../disposable/__fixtures__/accounts.ts"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import type { Enrolled } from "../disposable/types.ts"
import { contextOf, EMAIL_LOGIN, notesApi, notesDoc, optionsFor, withSignup } from "./__fixtures__/api.ts"
import { disposable, enrollerOf } from "./disposable.ts"

/* An operation that consumes its subject runs on a principal of its own, never the run's. */

const withAccountDelete = {
	"/account": {
		delete: { operationId: "account.delete", responses: { "204": { description: "gone" } }, "x-destructive": true },
	},
}

describe("disposable", () => {
	it("stands an operation down when nothing can read the caller back", async () => {
		const ctx = await contextOf(optionsFor(notesApi(notesDoc(withAccountDelete))))
		await disposable(ctx)
		expect(ctx.state.checksRun.has("auth.destructive-spares-the-caller")).toBe(true)
		expect(ctx.findings.findings).toEqual([])
	})

	it("signs each session up as a principal of its own, bound in the run's store", async () => {
		const ctx = await contextOf(
			optionsFor(
				withSignup(() => ({ status: 201 })),
				{
					principals: { alpha: { email: "alpha@x.test" } },
					security: EMAIL_LOGIN,
				},
			),
		)
		const enrolled = await enrollerOf(ctx)("one")
		expect(enrolled).toMatchObject({ id: "disposable-one" })
		const email = String(ctx.store.identityOf("disposable-one")["email"])
		const held = (await ctx.store.acquire({ principal: "disposable-one", scheme: "bearer" })) as Credential
		expect([held.value, ctx.principals.byId.has("disposable-one")]).toEqual([`login-${email}`, false])
	})

	it("takes only the targeted operations in a targeted run", async () => {
		const ctx = await contextOf(
			optionsFor(notesApi(notesDoc(withAccountDelete)), {
				hooks: { resolveInput: async () => null },
				ops: ["notes.list"],
			}),
		)
		await disposable(ctx)
		expect(ctx.state.checksRun.has("auth.destructive-spares-the-caller")).toBe(false)
	})
})

describe("disposable sessions that end", () => {
	/* Each second user adopts its signup's token, and renews by the declared refresh from its refresh_token. */
	const security: SecurityConfig = {
		session: {
			login: { from: "$.access_token", steps: [{ operationId: "auth.register" }] },
			refresh: {
				from: "$.access_token",
				steps: [{ body: { refresh_token: "{refresh_token}" }, operationId: "auth.refresh" }],
			},
		},
	}

	async function ended(refreshLives: boolean) {
		const doc = accountsDoc()
		const api = accountsApi(accounts({ refreshLives }))
		const options = optionsFor(
			(method, path, request) => (path === "/openapi.json" ? { body: doc, status: 200 } : api(method, path, request)),
			{
				ops: ["auth.logout"],
				principals: { alpha: { security: { session: { static: "alpha" } } } },
				security,
			},
		)
		const ctx = await contextOf(options)
		await disposable(ctx)
		return { ctx, seen: options.seen }
	}

	it("tries the session's declared refresh once it ended, and reports one that still renews", async () => {
		const { ctx, seen } = await ended(true)
		const refreshes = seen.filter((request) => request.path === "/v1/refresh")
		expect(refreshes.map((request) => request.body)).toEqual([{ refresh_token: "r1" }])
		expect(ctx.findings.findings).toContainEqual(
			expect.objectContaining({ summary: "the refresh token still renews after the session ended" }),
		)
	})

	it("proves the session ended when its refresh is refused too", async () => {
		const { ctx } = await ended(false)
		expect(ctx.findings.findings).toEqual([])
		expect(ctx.state.checksRun.has("auth.destructive-spares-the-caller")).toBe(true)
	})
})

/** The accounts API, its document served too. */
function serving(): Responder {
	const doc = accountsDoc()
	const api = accountsApi(accounts())
	return (method, path, request) => (path === "/openapi.json" ? { body: doc, status: 200 } : api(method, path, request))
}

describe("enrollerOf", () => {
	const alpha = { alpha: { security: { session: { static: "alpha" } } } }

	it("renews once by the declared refresh, and has nothing left to renew once that one failed", async () => {
		const security: SecurityConfig = {
			session: {
				login: { from: "$.access_token", steps: [{ operationId: "auth.register" }] },
				refresh: {
					from: "$.access_token",
					steps: [{ body: { refresh_token: "{refresh_token}" }, operationId: "auth.refresh" }],
				},
			},
		}
		const ctx = await contextOf(optionsFor(serving(), { principals: alpha, security }))
		const enrolled = (await enrollerOf(ctx)("one")) as Enrolled
		/* The refresh answers 200 with no access_token, so the store BLOCKS the session's credential. */
		expect([enrolled.scope, (await enrolled.renew?.())?.status]).toEqual([{}, 200])
		expect(await enrolled.renew?.()).toBeUndefined()
	})

	it("is BLOCKED by a signup the document cannot take, or a login that answers no credential", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		expect(await enrollerOf(ctx)("x")).toEqual({
			blocked: "signup for disposable-x: the document marks no x-fresh-principal operation",
		})
		const security: SecurityConfig = {
			session: { login: { from: "$.nope", steps: [{ operationId: "auth.register" }] } },
		}
		const odd = await contextOf(optionsFor(serving(), { principals: alpha, security }))
		expect(await enrollerOf(odd)("y")).toEqual({
			blocked: expect.stringMatching(/^login for disposable-y\/session: .*no credential at \$\.nope/),
		})
	})

	it("is BLOCKED when every recipe is static and fills the second user the caller's own credential", async () => {
		const signup = withSignup(() => ({ status: 201 }))
		const shared = await contextOf(optionsFor(signup, { security: { bearer: { static: "tok" } } }))
		expect(await enrollerOf(shared)("s")).toEqual({
			blocked:
				"every scheme's recipe is static and gives disposable-s the suite caller's own credential; a second user needs a login recipe",
		})
		const own = await contextOf(
			optionsFor(signup, {
				principals: { alpha: { email: "alpha@x.test" } },
				security: { bearer: { static: "tok-{principal.email}" } },
			}),
		)
		expect(await enrollerOf(own)("t")).toMatchObject({ id: "disposable-t" })
	})

	it("signs a session up with no renewal when the config names no recipe", async () => {
		const { security: _none, ...bare } = optionsFor(withSignup(() => ({ status: 201 })))
		const enrolled = (await enrollerOf(await contextOf(bare))("z")) as Enrolled
		expect([enrolled.id, enrolled.renew]).toEqual(["disposable-z", undefined])
	})
})
