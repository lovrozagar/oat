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
	it("picks a list over a GET of the same rank before it, takes the scheme alone and fills the path from the scope", () => {
		const ctx = stage("auth.revoke", {})
		expect(readRoute(ctx, "jwt")).toMatchObject({
			operation: { operationId: "notes.list" },
			path: "/projects/proj_a/notes",
		})
		expect(readRoute(ctx, "apiKey")).toMatchObject({ operation: { operationId: "notes.list" }, scopes: ["notes:read"] })
		expect(readRoute(ctx, "basic")).toBeUndefined()
	})

	it("skips a read whose path the scope leaves unfilled, or whose security the document does not declare", () => {
		const unscoped = operationContextFor(model, "auth.revoke", { principals: [actorOf("alpha")] }).ctx
		expect(readRoute(unscoped, "jwt")).toBeUndefined()
		const open = modelOf(undeclaredDoc())
		expect(readRoute(operationContextFor(open, "notes.list", { principals: [alpha] }).ctx, "jwt")).toBeUndefined()
	})
})

/* A jwt document of the given reads, each protected by the document's security; `auth.revoke` anchors. */
function readsDoc(paths: Record<string, unknown>) {
	return modelOf({
		components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } },
		info: { title: "reads", version: "1" },
		openapi: "3.1.0",
		paths: { "/auth/revoke": { post: { operationId: "auth.revoke", responses: OK } }, ...paths },
		security: [{ jwt: [] }],
	} as never)
}
const OK = { "200": { description: "ok" } }
const required = (where: string, name: string, schema: Record<string, unknown> = { type: "string" }) => ({
	in: where,
	name,
	required: true,
	schema,
})
const routeIn = (paths: Record<string, unknown>) =>
	readRoute(operationContextFor(readsDoc(paths), "auth.revoke", { principals: [alpha] }).ctx, "jwt")
const read = (operationId: string, parameters: unknown[]) => ({ get: { operationId, parameters, responses: OK } })
const STATS = {
	"/projects/{project_id}/stats": {
		get: { operationId: "stats.get", parameters: [required("path", "project_id")], responses: OK },
	},
}
const STATUS = { "/status": { get: { operationId: "status.get", responses: OK } } }
const ME = {
	"/users/me": {
		get: { operationId: "users.me", responses: OK, "x-entity": { action: "read", identity: "self", name: "me" } },
	},
}

describe("readRoute picks a read oat can send", () => {
	it("prefers a read with no required parameters, and among those the caller's own read or a list", () => {
		expect(routeIn({ ...STATS, ...STATUS, ...ME })).toMatchObject({ operation: { operationId: "users.me" } })
		expect(routeIn({ ...ME, ...STATUS })).toMatchObject({ operation: { operationId: "users.me" } })
		expect(routeIn({ ...STATS, ...STATUS })).toMatchObject({ operation: { operationId: "status.get" } })
		expect(routeIn(STATS)).toMatchObject({ path: "/projects/proj_a/stats" })
	})

	it("skips a required query, header or cookie parameter with no declared value, and sends one with a value", () => {
		expect(
			routeIn({
				"/a": read("a.query", [required("query", "albumId")]),
				"/b": read("b.header", [required("header", "X-Tenant")]),
				"/c": read("c.cookie", [required("cookie", "session-hint")]),
			}),
		).toBeUndefined()
		expect(
			routeIn({
				"/d": read("d.declared", [
					required("query", "kind", { enum: ["photo"], type: "string" }),
					required("header", "Idempotency-Key"),
					required("header", "Authorization"),
				]),
			}),
		).toMatchObject({ operation: { operationId: "d.declared" } })
	})

	it("fills a path parameter from a declared enum, and takes a HEAD as readily as a GET", () => {
		const region = required("path", "region", { enum: ["eu", "us"], type: "string" })
		expect(
			routeIn({ "/regions/{region}": { get: { operationId: "regions.get", parameters: [region], responses: OK } } }),
		).toMatchObject({ path: "/regions/eu" })
		expect(routeIn({ "/ping": { head: { operationId: "ping.head", responses: OK } } })).toMatchObject({
			method: "HEAD",
			operation: { operationId: "ping.head" },
			path: "/ping",
		})
	})
})

describe("lifecyclePlan", () => {
	it("pairs each anchored scheme with its route, and stands down without either", () => {
		const recipes = { apiKey: KEY, jwt: JWT }
		expect(lifecyclePlan(stage("auth.revoke", recipes), "revoke")).toMatchObject({
			ok: true,
			value: [{ route: { operation: { operationId: "notes.list" } }, scheme: "jwt" }],
		})
		expect(lifecyclePlan(stage("notes.list", recipes), "revoke").ok).toBe(false)
		const unscoped = operationContextFor(model, "auth.revoke", {
			principals: [actorOf("alpha")],
			probe: { recipes: recipes as never },
		}).ctx
		expect(lifecyclePlan(unscoped, "revoke")).toEqual({
			needs: "no read this credential protects that oat can send",
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
