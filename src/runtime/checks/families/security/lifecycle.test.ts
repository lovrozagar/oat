import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import { modelOf } from "../../__fixtures__/harness.ts"
import { actorOf, operationContextFor } from "./__fixtures__/operation-context.ts"
import { securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { ASSERTED } from "../../../finding.ts"
import { anchoredSchemes, isRefused, lifecyclePlan, readRoute, settle, unlessUnsatisfied } from "./lifecycle.ts"

/* Where a credential-lifecycle check anchors, once per scheme, and the one route it proves a credential on. */

const model = modelOf(securedDoc())
const alpha = actorOf("alpha", { scope: { project_id: "proj_a" }, tenant: "proj_a" })
const JWT = { issue: "auth.login", kind: "login", refresh: "auth.refresh", revoke: "auth.revoke" } as const
const KEY = { issue: "apiKey.create", kind: "mint", revoke: "apiKey.revoke" } as const

const stage = (operationId: string, recipes: Record<string, unknown>) =>
	operationContextFor(model, operationId, { principals: [alpha], probe: { recipes: recipes as never } }).ctx

describe("anchoredSchemes", () => {
	it("anchors on the operation the actor's recipe names for the step, once per scheme", () => {
		expect(anchoredSchemes(stage("auth.revoke", { apiKey: KEY, jwt: JWT }), { kind: "revoke" })).toEqual({
			ok: true,
			value: ["jwt"],
		})
		expect(anchoredSchemes(stage("apiKey.revoke", { apiKey: KEY, jwt: JWT }), { kind: "revoke" })).toEqual({
			ok: true,
			value: ["apiKey"],
		})
	})

	it("stands down elsewhere naming where it runs, and with every scheme's reason when nothing anchors", () => {
		expect(anchoredSchemes(stage("notes.list", { apiKey: KEY, jwt: JWT }), { kind: "revoke" })).toEqual({
			needs: "the revoke operation of a recipe; this check runs on apiKey.revoke, auth.revoke",
			ok: false,
		})
		expect(
			anchoredSchemes(stage("notes.list", { apiKey: { kind: "static" }, jwt: { kind: "login" } }), { kind: "refresh" }),
		).toEqual({
			needs: "apiKey: the static recipe declares no refresh; jwt: the login recipe declares no refresh",
			ok: false,
		})
		expect(anchoredSchemes(stage("notes.list", {}), { kind: "issue" })).toEqual({
			needs: "apiKey: no apiKey recipe in this test; jwt: no jwt recipe in this test",
			ok: false,
		})
	})
})

describe("anchoredSchemes (2)", () => {
	it("anchors a login-only check on a login recipe's issuing step alone", () => {
		const recipes = { apiKey: KEY, jwt: JWT }
		expect(anchoredSchemes(stage("auth.login", recipes), { kind: "issue", login: true })).toEqual({
			ok: true,
			value: ["jwt"],
		})
		expect(anchoredSchemes(stage("notes.list", recipes), { kind: "issue", login: true })).toEqual({
			needs: "the issue operation of a recipe; this check runs on auth.login",
			ok: false,
		})
		expect(anchoredSchemes(stage("auth.login", { jwt: { kind: "hook" } }), { kind: "issue", login: true })).toEqual({
			needs: "apiKey: no apiKey recipe in this test; jwt: hook recipes have no login step",
			ok: false,
		})
		expect(anchoredSchemes(stage("auth.login", { jwt: { kind: "login" } }), { kind: "issue" })).toEqual({
			needs: "apiKey: no apiKey recipe in this test; jwt: the login recipe declares no documented issuing step",
			ok: false,
		})
	})

	it("names no scheme when the document declares none", () => {
		const bare = modelOf({
			info: { title: "bare", version: "1" },
			openapi: "3.1.0",
			paths: { "/x": { get: { operationId: "x.get", responses: { "200": { description: "ok" } } } } },
		} as never)
		expect(anchoredSchemes(operationContextFor(bare, "x.get").ctx, { kind: "revoke" })).toEqual({
			needs: "a declared security scheme",
			ok: false,
		})
	})
})

describe("readRoute", () => {
	it("picks the first GET in document order that takes the scheme alone and whose path the actor's scope fills", () => {
		const ctx = stage("auth.revoke", {})
		expect(readRoute(ctx, "jwt")).toMatchObject({
			operation: { operationId: "feed.list" },
			path: "/projects/proj_a/feed",
		})
		expect(readRoute(ctx, "apiKey")).toMatchObject({ operation: { operationId: "feed.list" }, scopes: ["notes:read"] })
		expect(readRoute(ctx, "basic")).toBeUndefined()
	})

	it("skips a read whose path the scope leaves unfilled, or whose security the document does not declare", () => {
		const unscoped = operationContextFor(model, "auth.revoke", { principals: [actorOf("alpha")] }).ctx
		expect(readRoute(unscoped, "jwt")).toBeUndefined()
		const open = modelOf(undeclaredDoc())
		expect(readRoute(operationContextFor(open, "notes.list", { principals: [alpha] }).ctx, "jwt")).toBeUndefined()
	})
})

describe("lifecyclePlan", () => {
	it("pairs each anchored scheme with its route, and stands down without either", () => {
		const recipes = { apiKey: KEY, jwt: JWT }
		expect(lifecyclePlan(stage("auth.revoke", recipes), "revoke")).toMatchObject({
			ok: true,
			value: [{ route: { operation: { operationId: "feed.list" } }, scheme: "jwt" }],
		})
		expect(lifecyclePlan(stage("notes.list", recipes), "revoke").ok).toBe(false)
		const unscoped = operationContextFor(model, "auth.revoke", {
			principals: [actorOf("alpha")],
			probe: { recipes: recipes as never },
		}).ctx
		expect(lifecyclePlan(unscoped, "revoke")).toEqual({
			needs: "a GET that accepts jwt alone and whose path parameters alpha's scope fills",
			ok: false,
		})
	})

	it("stands down where the document declares no security", () => {
		const open = modelOf(undeclaredDoc())
		const ctx = operationContextFor(open, "auth.revoke", { principals: [alpha] }).ctx
		expect(lifecyclePlan(ctx, "revoke")).toEqual({
			needs: "the document declares no security; add an overlay",
			ok: false,
		})
	})
})

describe("isRefused", () => {
	it("counts 401 and 403 as refusals", () => {
		expect([401, 403, 200, 404, 500].map(isRefused)).toEqual([true, true, false, false, false])
	})
})

describe("settle", () => {
	const finding = { kind: "finding", verdict: "SECURITY" } as const
	const unresolved = { kind: "unresolved", reason: "r" } as const

	it("reports a finding first, then an unresolved run, then a pass naming what stayed untested", () => {
		expect(settle([{ untested: "a" }, unresolved, finding])).toEqual(finding)
		expect(settle([unresolved, ASSERTED])).toEqual(unresolved)
		expect(settle([ASSERTED, { untested: "apiKey: static recipes cannot issue a dedicated credential" }])).toEqual({
			kind: "asserted",
			note: "untested: apiKey: static recipes cannot issue a dedicated credential",
		})
		expect(settle([ASSERTED])).toEqual(ASSERTED)
	})

	it("stands down with every reason when no scheme could be tested", () => {
		expect(settle([{ untested: "a" }, { untested: "b" }])).toEqual({ kind: "stood-down", reason: "a; b" })
	})
})

describe("unlessUnsatisfied", () => {
	it("is what the work decided, untested with whose request and why when a credential cannot be sent, and any other throw", async () => {
		expect(await unlessUnsatisfied("beta's key", async () => ASSERTED)).toEqual(ASSERTED)
		const blocked = new UnsatisfiedSecurity("blocked", "mint for beta/apiKey: apiKey.create answered 403")
		expect(
			await unlessUnsatisfied("beta's key", async () => {
				throw blocked
			}),
		).toEqual({ untested: "beta's key: mint for beta/apiKey: apiKey.create answered 403" })
		await expect(
			unlessUnsatisfied("beta's key", async () => {
				throw new Error("socket closed")
			}),
		).rejects.toThrow("socket closed")
	})
})
