import { describe, expect, it } from "vitest"
import type { Credential } from "../../credentials/store.ts"
import type { Answer } from "../checks/__fixtures__/harness.ts"
import { EMAIL_LOGIN, connected, notesApi, notesDoc, optionsFor, withSignup } from "./__fixtures__/api.ts"
import { type Provisioned, provision } from "./fresh.ts"

/* A fresh principal: signed up by the document's x-fresh-principal operation and bound in the store. */

const ALPHA = { alpha: { email: "alpha@x.test" } }

async function provisioned(signup: (body: Record<string, unknown>) => Answer, entry = {}) {
	const options = optionsFor(withSignup(signup), { principals: ALPHA, security: EMAIL_LOGIN })
	const ctx = await connected(options)
	const made = await provision(ctx, { entry, id: "fresh-1", label: "one" })
	return { ctx, made, seen: options.seen }
}

describe("provision", () => {
	it("binds the signup's values into identity and holds the credential its answer carries", async () => {
		const { ctx, made, seen } = await provisioned((body) => ({
			body: { access_token: "signed-up", id: 7, echo: Object.keys(body).length },
			status: 201,
		}))
		const held = (await ctx.store.acquire({ principal: "fresh-1", scheme: "bearer" })) as Credential
		expect(held.value).toBe("signed-up")
		expect(seen.map((request) => request.path)).toEqual(["/openapi.json", "/signup"])
		const sent = seen[1]?.body as Record<string, unknown>
		expect(seen[1]?.headers.authorization).toBeUndefined()
		expect(made).toEqual({ id: "fresh-1", known: { access_token: "signed-up", ...sent } })
		const identity = ctx.store.identityOf("fresh-1")
		expect([identity.email, identity.password]).toEqual([sent.email, sent.password])
		/* A body field named like a grade never sets one. */
		expect([typeof sent.tenant, identity.tenant]).toEqual(["string", undefined])
	})

	it("signs it in by its recipe, as the identity it signed up with, when the answer carries no credential", async () => {
		const { ctx, made, seen } = await provisioned(() => ({ body: ["not", "an", "object"], status: 201 }))
		const held = (await ctx.store.acquire({ principal: "fresh-1", scheme: "bearer" })) as Credential
		const email = (seen[1]?.body as Record<string, unknown> | undefined)?.email
		expect([held.value, seen[2]?.path, (made as { known: object }).known]).toEqual([
			`login-${String(email)}`,
			"/login",
			seen[1]?.body,
		])
	})

	it("keeps a principal's own recipe, which may read nothing from the signup", async () => {
		const { ctx } = await provisioned(() => ({ status: 201 }), { security: { bearer: { static: "own" } } })
		expect(((await ctx.store.acquire({ principal: "fresh-1", scheme: "bearer" })) as Credential).value).toBe("own")
	})

	it("binds the signup alone for an API whose config names no recipe", async () => {
		const { security: _none, ...bare } = optionsFor(withSignup(() => ({ body: { access_token: "t" }, status: 201 })))
		const ctx = await connected(bare)
		expect(await provision(ctx, { entry: {}, id: "fresh-5", label: "five" })).toMatchObject({ id: "fresh-5" })
		expect(await ctx.store.snapshot()).toEqual([])
	})
})

describe("provision, when it cannot or need not read a credential", () => {
	it("is BLOCKED with the reason when the signup is refused, or the document marks no signup", async () => {
		const { made } = await provisioned(() => ({ status: 409 }))
		expect(made).toEqual({ blocked: "signup for fresh-1 by auth.signup: answered 409" })
		const ctx = await connected(optionsFor(notesApi()))
		expect(await provision(ctx, { entry: {}, id: "fresh-2", label: "two" })).toEqual({
			blocked: "signup for fresh-2: the document marks no x-fresh-principal operation",
		})
	})

	it("sends an empty body to a signup that documents none, through resolveInput's eye when there is one", async () => {
		const bare = notesDoc({
			"/signup": {
				post: {
					operationId: "auth.signup",
					responses: { "201": { description: "made" } },
					security: [],
					"x-fresh-principal": true,
				},
			},
		})
		const respond = (method: string, path: string) =>
			path === "/signup" ? { body: { access_token: "t" }, status: 201 } : notesApi(bare)(method, path, {})
		const ctx = await connected(optionsFor(respond, { principals: ALPHA, security: EMAIL_LOGIN }))
		expect(await provision(ctx, { entry: {}, id: "fresh-3", label: "three" })).toEqual({
			id: "fresh-3",
			known: { access_token: "t" },
		})
		const hooked = optionsFor(
			withSignup(() => ({ status: 201 })),
			{
				hooks: { resolveInput: async ({ field }) => (field === "email" ? "chosen@x.test" : null) },
				principals: ALPHA,
				security: EMAIL_LOGIN,
			},
		)
		const resolved = await provision(await connected(hooked), { entry: {}, id: "fresh-4", label: "four" })
		expect((resolved as Provisioned).known.email).toBe("chosen@x.test")
	})
})

describe("provision: what a signup body cannot set", () => {
	it("never lets a signup body's readOnly mark the principal read-only", async () => {
		const body = { properties: { readOnly: { const: true, type: "boolean" } }, required: ["readOnly"], type: "object" }
		const doc = notesDoc({
			"/signup": {
				post: {
					operationId: "auth.signup",
					requestBody: { content: { "application/json": { schema: body } }, required: true },
					responses: { "201": { description: "made" } },
					security: [],
					"x-fresh-principal": true,
				},
			},
		})
		const respond = (method: string, path: string) =>
			path === "/signup" ? { body: { access_token: "t" }, status: 201 } : notesApi(doc)(method, path, {})
		const ctx = await connected(optionsFor(respond, { principals: ALPHA, security: EMAIL_LOGIN }))
		const made = (await provision(ctx, { entry: {}, id: "fresh-5", label: "five" })) as Provisioned
		expect(made.known.readOnly).toBe(true)
		expect(ctx.store.principals["fresh-5"]).not.toHaveProperty("readOnly")
	})
})
