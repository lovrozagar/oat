import { describe, expect, it } from "vitest"
import { fakePorts, NOW } from "./__fixtures__/ports.ts"
import { PRINCIPALS, SCHEMES, SECURITY } from "./__fixtures__/store.ts"
import type { Issued } from "./recipes/types.ts"
import { acquireCtx, blockedBy, identityOf, type Plan, planOf, record, storeCtx } from "./store-plan.ts"

/* The store's internals: a key planned against the config, and an issued credential taken in. */

const ctxOf = () =>
	storeCtx({ now: () => NOW, ports: fakePorts().ports, principals: PRINCIPALS, schemes: SCHEMES, security: SECURITY })

const planned = (ctx: ReturnType<typeof ctxOf>, principal: string, scheme: string, scopes?: string[]): Plan =>
	planOf(ctx, { principal, scheme, ...(scopes === undefined ? {} : { scopes }) }) as Plan

const revoke = async (): Promise<void> => undefined

describe("storeCtx", () => {
	it("copies the config's principals, defaulting the clock and the refresh buffer", () => {
		const ctx = storeCtx({ ports: fakePorts().ports, principals: PRINCIPALS, schemes: SCHEMES, security: SECURITY })
		ctx.principals["zed"] = {}
		expect(PRINCIPALS).not.toHaveProperty("zed")
		expect([ctx.bufferMs, typeof ctx.now(), ctx.probes]).toEqual([30_000, "number", 0])
	})
})

describe("planOf", () => {
	it("keys a login by principal × scheme alone, and a mint by its sorted scopes too", () => {
		const ctx = ctxOf()
		expect(planned(ctx, "ann", "jwt", ["b"])).toMatchObject({ id: "ann\u0000jwt\u0000", scopes: [] })
		expect(planned(ctx, "ann", "key", ["b", "a"])).toMatchObject({ id: "ann\u0000key\u0000a b", scopes: ["a", "b"] })
		expect(planned(ctx, "ann", "key")).toMatchObject({ scopes: [] })
	})

	it("is blocked for an unknown principal, scheme or recipe, and for a pair a refresh blocked unless adopting", () => {
		const ctx = ctxOf()
		expect(planOf(ctx, { principal: "constructor", scheme: "jwt" })).toEqual({
			blocked: 'no principal "constructor" in the config',
		})
		expect(planOf(ctx, { principal: "ann", scheme: "nope" })).toEqual({
			blocked: 'the document declares no "nope" scheme',
		})
		expect(planOf(ctx, { principal: "ann", scheme: "basic" })).toEqual({
			blocked: 'principal "ann" has no recipe for the "basic" scheme',
		})
		ctx.blocked.set("ann\u0000jwt", { blocked: "refresh failed" })
		expect(planOf(ctx, { principal: "ann", scheme: "jwt" })).toEqual({ blocked: "refresh failed" })
		expect(planOf(ctx, { principal: "ann", scheme: "jwt" }, { adopting: true })).toHaveProperty("id")
	})
})

const issued = (more: Partial<Issued> = {}): Issued => ({ expiresAt: null, value: "v1", ...more })

describe("record", () => {
	it("places the value, keeps its scopes, and binds what it bound into the principal's identity", () => {
		const ctx = ctxOf()
		const entry = record(ctx, planned(ctx, "ann", "key", ["a"]), issued({ identity: { tenant: "t9" }, scopes: ["a"] }))
		expect(entry.credential).toMatchObject({ scopes: ["a"], sends: { headers: { Authorization: "ApiKey v1" } } })
		expect(entry.key).toMatchObject({ principal: "ann", scheme: "key", scopes: ["a"] })
		expect(identityOf(ctx, "ann")).toEqual({ email: "ann@x.io", tenant: "t9" })
		expect(record(ctx, planned(ctx, "ann", "key"), issued()).credential).not.toHaveProperty("scopes")
	})

	it("registers each mint's revoke apart, and a login's only for a probe principal's session, replaced as it rotates", () => {
		const ctx = ctxOf()
		record(ctx, planned(ctx, "ann", "key", ["a"]), issued({ revoke }))
		record(ctx, planned(ctx, "ann", "key", ["a"]), issued({ revoke }))
		expect(record(ctx, planned(ctx, "ann", "jwt"), issued({ revoke })).revokeKey).toBeUndefined()
		ctx.principals["ann#probe-1"] = {}
		ctx.dedicated.add("ann#probe-1")
		const session = planned(ctx, "ann#probe-1", "jwt")
		expect(record(ctx, session, issued({ revoke })).revokeKey).toBe(session.id)
		record(ctx, session, issued({ revoke, value: "v2" }))
		expect([...ctx.revokes.values()].map((each) => `${each.principal}/${each.scheme}`)).toEqual([
			"ann/key",
			"ann/key",
			"ann/jwt",
		])
	})
})

describe("blockedBy and acquireCtx", () => {
	it("name the owner of a probe principal, never the probe", () => {
		const ctx = ctxOf()
		ctx.principals["ann#probe-2"] = {}
		const plan = planned(ctx, "ann#probe-2", "jwt")
		expect(blockedBy("login", plan, new Error('login for "ann#probe-2" failed'))).toBe(
			'login for ann/jwt: login for "ann" failed',
		)
		expect(acquireCtx(ctx, plan)).toMatchObject({ principal: { id: "ann#probe-2", identity: {} }, scopes: [] })
		expect(identityOf(ctx, "nobody")).toEqual({})
		ctx.principals["viewer"] = { email: "v@x.io", readOnly: true }
		expect(identityOf(ctx, "viewer")).toEqual({ email: "v@x.io" })
	})
})
