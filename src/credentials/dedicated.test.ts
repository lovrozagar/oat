import { describe, expect, it } from "vitest"
import type { LoginRecipe } from "../config/types/security.ts"
import { harness } from "./__fixtures__/store.ts"
import type { DedicatedHeld } from "./store.ts"

/*
 * A dedicated credential is a probe's alone: a second login, a fresh mint, a new grant, held under a
 * probe principal the store enrolls. Revoking or rotating it never touches the principal's own.
 */

const dedicated = (held: DedicatedHeld | { blocked: string }): DedicatedHeld => {
	if ("blocked" in held) throw new Error(held.blocked)
	return held
}

const rotateOf = (held: DedicatedHeld) => (held.rotate as NonNullable<DedicatedHeld["rotate"]>)()

describe("acquireDedicated: by recipe", () => {
	it("signs in a second time under a probe principal with the owner's identity, leaving the owner's session", async () => {
		const { recorded, store } = harness()
		const own = await store.acquire({ principal: "ann", scheme: "jwt" })
		const probe = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "jwt" }))
		expect(probe).toMatchObject({ owner: "ann", principal: "ann#probe-1", scheme: "jwt" })
		expect(probe.credential.value).not.toBe((own as { value: string }).value)
		expect(recorded.runs.map((run) => [run.principal, run.steps[0]])).toEqual([
			["ann", { body: { email: "ann@x.io" }, operationId: "auth.login" }],
			["ann#probe-1", { body: { email: "ann@x.io" }, operationId: "auth.login" }],
		])
		expect(await store.acquire({ principal: "ann#probe-1", scheme: "jwt" })).toEqual(probe.credential)
		expect(store.principals["ann#probe-1"]).toEqual({ email: "ann@x.io", rank: 2, tenant: "t1" })
		expect(store.identityOf("ann#probe-1")).toEqual(store.identityOf("ann"))
	})

	it("mints a fresh key with the owner's own session, and numbers each probe principal", async () => {
		const { mintCalls, store } = harness()
		const first = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "key", scopes: ["b", "a"] }))
		const second = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "key", scopes: ["a", "b"] }))
		expect([first.principal, first.credential.value, second.principal, second.credential.value]).toEqual([
			"ann#probe-1",
			"k1",
			"ann#probe-2",
			"k2",
		])
		expect(mintCalls().map((call) => call.as)).toEqual([
			{ principal: "ann", scheme: "jwt" },
			{ principal: "ann", scheme: "jwt" },
		])
		expect(first.rotate).toBeUndefined()
	})
})

describe("acquireDedicated: shared by probes that never spend it", () => {
	it("mints one per principal, scheme and scope set however the scopes are ordered, and a spent one each time", async () => {
		const { mintCalls, store } = harness()
		const shared = { reusable: true } as const
		const first = dedicated(
			await store.acquireDedicated({ principal: "ann", scheme: "key", scopes: ["b", "a"] }, shared),
		)
		const again = dedicated(
			await store.acquireDedicated({ principal: "ann", scheme: "key", scopes: ["a", "b"] }, shared),
		)
		const other = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "key", scopes: ["a"] }, shared))
		const spent = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "key", scopes: ["a", "b"] }))
		expect([first, again, other, spent].map((held) => held.principal)).toEqual([
			"ann#probe-1",
			"ann#probe-1",
			"ann#probe-2",
			"ann#probe-3",
		])
		expect(mintCalls()).toHaveLength(3)
	})

	it("shares a second login that asks no scopes the same way", async () => {
		const { store } = harness()
		const login = { principal: "ann", scheme: "jwt" }
		const first = dedicated(await store.acquireDedicated(login, { reusable: true }))
		const again = dedicated(await store.acquireDedicated(login, { reusable: true }))
		expect([first.principal, again.principal]).toEqual(["ann#probe-1", "ann#probe-1"])
	})
})

describe("acquireDedicated: by recipe, refusals", () => {
	it("refuses a static or hook recipe, a login that signs up, and an owner whose login failed", async () => {
		const { store } = harness({ login: new Set(["cy"]) })
		expect(await store.acquireDedicated({ principal: "bob", scheme: "jwt" })).toEqual({
			blocked: "static recipes cannot issue a dedicated credential",
		})
		const blocked = await store.acquire({ principal: "cy", scheme: "jwt" })
		expect(await store.acquireDedicated({ principal: "cy", scheme: "jwt" })).toEqual(blocked)
		expect(await store.acquireDedicated({ principal: "nobody", scheme: "jwt" })).toEqual({
			blocked: 'no principal "nobody" in the config',
		})
		const signup = { method: "POST", operationId: "auth.login", path: "/login" }
		const { store: signing } = harness({ signup })
		expect(await signing.acquireDedicated({ principal: "ann", scheme: "jwt" })).toEqual({
			blocked: "a second login for ann/jwt would sign it up again",
		})
	})

	it("reports a failed second login by the owner's name, never the probe's", async () => {
		const failing = new Set<string>()
		const { store } = harness({ login: failing })
		failing.add("ann#probe-1")
		expect(await store.acquireDedicated({ principal: "ann", scheme: "jwt" })).toEqual({
			blocked: "login for ann/jwt: auth step 1 answered 401",
		})
		const { store: claiming } = harness()
		const login: LoginRecipe = { claims: { tenant: "org_id" }, from: "$.token", steps: [{ operationId: "auth.login" }] }
		claiming.enroll("eve", { security: { jwt: { login } } })
		expect(await claiming.acquireDedicated({ principal: "eve", scheme: "jwt" })).toEqual({
			blocked: 'login for eve/jwt: login for "eve" binds claims, but its credential is not a JWT',
		})
	})
})

describe("acquireDedicated: revoke", () => {
	it("revokes by the declared path once, sending exactly its value, so teardown does not revoke it again", async () => {
		const { recorded, store } = harness()
		const probe = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "jwt" }))
		await probe.revoke?.()
		await probe.revoke?.()
		expect(await store.revokeAll()).toEqual([])
		const logouts = recorded.calls.filter((call) => call.operationId === "auth.logout")
		expect(logouts.map((call) => [call.as, call.value])).toEqual([
			[{ principal: "ann#probe-1", scheme: "jwt" }, probe.credential.value],
		])
	})

	it("is revoked at teardown when no probe revoked it, a failure named by its owner", async () => {
		const { store } = harness({ logout: () => 500 })
		await store.acquireDedicated({ principal: "ann", scheme: "jwt" })
		await store.acquireDedicated({ principal: "ann", scheme: "key", scopes: ["a"] })
		expect(await store.revokeAll()).toEqual([
			{ principal: "ann", reason: "revoke auth.logout answered 500", scheme: "jwt" },
		])
	})

	it("keeps a revoke that failed for teardown, and has none to offer without a declared path", async () => {
		let status = 500
		const { store } = harness({ logout: () => status })
		const probe = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "jwt" }))
		await expect(probe.revoke?.()).rejects.toThrow("revoke auth.logout answered 500")
		status = 204
		expect(await store.revokeAll()).toEqual([])
		const { store: other } = harness()
		const minted = dedicated(await other.acquireDedicated({ principal: "dee", scheme: "jwt" }))
		expect(minted.revoke).toBeUndefined()
	})
})

describe("acquireDedicated: rotation", () => {
	it("rotates by the declared refresh, and a replay of the rotated refresh is refused on a rotating server", async () => {
		const { store } = harness({ rotates: true })
		const probe = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "jwt" }))
		const rotated = await (probe.rotate as NonNullable<DedicatedHeld["rotate"]>)()
		expect(rotated.credential.value).not.toBe(probe.credential.value)
		expect(await store.acquire({ principal: "ann#probe-1", scheme: "jwt" })).toEqual(rotated.credential)
		await expect(rotated.replay()).rejects.toThrow("auth step 1 answered 401")
	})

	it("accepts a replay on a server that does not rotate, and revokes the session the replay opened at teardown", async () => {
		const { recorded, store } = harness()
		const probe = dedicated(await store.acquireDedicated({ principal: "ann", scheme: "jwt" }))
		await (await rotateOf(probe)).replay()
		await store.revokeAll()
		expect(recorded.calls.filter((call) => call.operationId === "auth.logout")).toHaveLength(2)
	})

	it("registers no revoke for a replay whose recipe declares none, so teardown has none to run", async () => {
		const { recorded, store } = harness()
		const login: LoginRecipe = { from: "$.token", steps: [{ operationId: "auth.login" }] }
		store.enroll("zoe", { email: "zoe@x.io", security: { jwt: { login, refresh: login } } })
		const probe = dedicated(await store.acquireDedicated({ principal: "zoe", scheme: "jwt" }))
		expect(probe.revoke).toBeUndefined()
		expect(await (await rotateOf(probe)).replay()).toBeUndefined()
		expect(await store.revokeAll()).toEqual([])
		expect(recorded.calls.filter((call) => call.operationId === "auth.logout")).toEqual([])
	})
})
