import { describe, expect, it } from "vitest"
import { jwtOf } from "../__fixtures__/jwt.ts"
import { ctxOf, fakePorts, NOW, rejection } from "../__fixtures__/ports.ts"
import { acquireStatic } from "./static.ts"

const { ports } = fakePorts()

describe("acquireStatic", () => {
	it("is the configured string, with the principal filled in", async () => {
		expect(await acquireStatic(ctxOf(ports), "key-{principal.email}", {})).toEqual({
			expiresAt: null,
			value: "key-ann@x.io",
		})
	})

	it("is a basic pair as `user:pass`, which the placement base64s", async () => {
		const pair = { password: "{principal.password}", username: "{principal.email}" }
		expect((await acquireStatic(ctxOf(ports), pair, {})).value).toBe("ann@x.io:pw")
	})

	it("lapses by `expiresIn` seconds, or the JWT's exp", async () => {
		expect((await acquireStatic(ctxOf(ports), "k", { expiresIn: 60 })).expiresAt).toBe(NOW + 60_000)
		expect((await acquireStatic(ctxOf(ports), jwtOf({ exp: 9 }), {})).expiresAt).toBe(9000)
	})

	it("serves the scopes it `holds`, and refuses the rest with the reason", async () => {
		const ctx = ctxOf(ports, { scopes: ["rows:read"] })
		expect((await acquireStatic(ctx, "k", { holds: ["rows:read", "rows:write"] })).value).toBe("k")
		expect((await rejection(acquireStatic(ctx, "k", {}))).message).toBe('the "jwt" credential does not hold rows:read')
	})
})
