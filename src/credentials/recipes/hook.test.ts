import { describe, expect, it } from "vitest"
import { jwtOf } from "../__fixtures__/jwt.ts"
import { ctxOf, fakePorts, NOW, rejection } from "../__fixtures__/ports.ts"
import { acquireHook } from "./hook.ts"

describe("acquireHook", () => {
	it("asks hooks.resolveCredential afresh on every acquire, so a TOTP code is new each time", async () => {
		let code = 100
		const { ports, recorded } = fakePorts({ hook: () => Promise.resolve(String(code++)) })
		const first = await acquireHook(ctxOf(ports), {})
		const second = await acquireHook(ctxOf(ports), {})
		expect([first.value, second.value, first.expiresAt]).toEqual(["100", "101", null])
		expect(recorded.hooks).toEqual([
			{ principal: "ann", scheme: "jwt" },
			{ principal: "ann", scheme: "jwt" },
		])
	})

	it("passes the principal's id and identity", async () => {
		const seen: unknown[] = []
		const { ports } = fakePorts({
			hook: (scheme, principal) => {
				seen.push([scheme, principal])
				return Promise.resolve("v")
			},
		})
		await acquireHook(ctxOf(ports), {})
		expect(seen).toEqual([["jwt", { id: "ann", identity: { email: "ann@x.io", password: "pw" } }]])
	})

	it("takes the hook's lifetime over the recipe's, then the recipe's, then the JWT's", async () => {
		const answers = [{ expiresIn: 30, value: "a" }, { value: "b" }, { value: jwtOf({ exp: 7 }) }]
		const { ports } = fakePorts({ hook: () => Promise.resolve(answers.shift() ?? null) })
		expect((await acquireHook(ctxOf(ports), { expiresIn: 60 })).expiresAt).toBe(NOW + 30_000)
		expect((await acquireHook(ctxOf(ports), { expiresIn: 60 })).expiresAt).toBe(NOW + 60_000)
		expect((await acquireHook(ctxOf(ports), {})).expiresAt).toBe(7000)
	})

	it("fails with a reason when the hook answers null or is not set", async () => {
		const { ports } = fakePorts({ hook: () => Promise.resolve(null) })
		expect((await rejection(acquireHook(ctxOf(ports), {}))).message).toBe(
			'hooks.resolveCredential gave no credential for "ann" on scheme "jwt"',
		)
		expect((await rejection(acquireHook(ctxOf(fakePorts().ports), {}))).message).toBe(
			"the jwt recipe is `hook: true`, but the config sets no hooks.resolveCredential",
		)
	})

	it("serves the scopes it `holds`, and refuses the rest before calling the hook", async () => {
		const { ports, recorded } = fakePorts({ hook: () => Promise.resolve("v") })
		const ctx = ctxOf(ports, { scopes: ["admin"] })
		expect((await acquireHook(ctx, { holds: ["admin"] })).value).toBe("v")
		expect((await rejection(acquireHook(ctx, {}))).message).toBe('the "jwt" credential does not hold admin')
		expect(recorded.hooks).toHaveLength(1)
	})
})
