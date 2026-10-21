import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../../config/types/security.ts"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import { contextOf, LOGIN, optionsFor, overriding, withLogin } from "./__fixtures__/api.ts"
import { keysApi, MINTED } from "./__fixtures__/keys.ts"
import { probeCredentials } from "./probe-credentials.ts"

/* What an operation check probes with: a dedicated credential of a principal's own, or the value it holds. */

const ROTATING: SecurityConfig = {
	bearer: {
		login: { from: "$.token", revoke: "notes.list", steps: [{ operationId: "auth.login" }] },
		refresh: { from: "$.token", steps: [{ operationId: "auth.login" }] },
	},
}

describe("probeCredentials", () => {
	it("acquires a dedicated session that is not the principal's own, revokes it and rotates it", async () => {
		const ctx = await contextOf(optionsFor(withLogin(), { security: ROTATING }))
		const probe = probeCredentials(ctx)
		const own = await probe.held({ principal: "alpha", scheme: "bearer" })
		const dedicated = await probe.dedicated({ principal: "alpha", scheme: "bearer" })
		if ("untested" in dedicated || "untested" in own) throw new Error("expected credentials")
		expect(dedicated).toMatchObject({ actor: { principal: "alpha#probe-1" }, owner: "alpha", scheme: "bearer" })
		expect(dedicated.value).not.toBe(own.value)
		const rotated = await dedicated.rotate?.()
		expect(rotated?.value).not.toBe(dedicated.value)
		expect(await rotated?.replay()).toEqual({ accepted: true })
		await dedicated.revoke?.()
		expect(ctx.principals.all.map((principal) => principal.id)).toEqual(["alpha"])
		expect(ctx.principals.byId.has("alpha#probe-1")).toBe(false)
	})

	it("offers no revoke or rotate for a recipe that declares neither", async () => {
		const ctx = await contextOf(optionsFor(withLogin(), { security: LOGIN }))
		const dedicated = await probeCredentials(ctx).dedicated({ principal: "alpha", scheme: "bearer" })
		if ("untested" in dedicated) throw new Error(dedicated.untested)
		expect([dedicated.revoke, dedicated.rotate]).toEqual([undefined, undefined])
	})

	it("reports a refused replay with its reason, and is untested where no credential can be had", async () => {
		let logins = 0
		const once: Responder = (_method, path) => (path === "/login" && ++logins > 3 ? { status: 401 } : undefined)
		const ctx = await contextOf(optionsFor(overriding(withLogin(), once), { security: ROTATING }))
		const probe = probeCredentials(ctx)
		const dedicated = await probe.dedicated({ principal: "alpha", scheme: "bearer" })
		if ("untested" in dedicated) throw new Error(dedicated.untested)
		const rotated = await dedicated.rotate?.()
		expect(await rotated?.replay()).toEqual({ accepted: false, reason: expect.stringMatching(/401/) })
		expect(await probe.held({ principal: "nobody", scheme: "bearer" })).toEqual({
			untested: 'no principal "nobody" in the config',
		})
		const plain = await contextOf(optionsFor(withLogin(), { security: { bearer: { static: "s3cr3t-key" } } }))
		expect(await probeCredentials(plain).dedicated({ principal: "alpha", scheme: "bearer" })).toEqual({
			untested: "static recipes cannot issue a dedicated credential",
		})
	})
})

describe("probeCredentials: a dedicated credential no probe spends", () => {
	it("shares one per principal and scheme across the run's probes, and gives a probe that spends one its own", async () => {
		const ctx = await contextOf(optionsFor(withLogin(), { security: ROTATING }))
		const shared = { principal: "alpha", reusable: true, scheme: "bearer" } as const
		const first = await probeCredentials(ctx).dedicated(shared)
		const again = await probeCredentials(ctx).dedicated(shared)
		const spent = await probeCredentials(ctx).dedicated({ principal: "alpha", scheme: "bearer" })
		expect([first, again, spent].map((held) => ("untested" in held ? held.untested : held.actor.principal))).toEqual([
			"alpha#probe-1",
			"alpha#probe-1",
			"alpha#probe-2",
		])
	})
})

describe("probeCredentials: recipe", () => {
	it("reads the principal's effective recipe: a login by its steps, raw ones by their documented operation", async () => {
		const security: SecurityConfig = {
			bearer: {
				login: { from: "$.token", revoke: "notes.list", steps: [{ method: "post", path: "/login" }] },
				refresh: { from: "$.token", steps: [{ operationId: "auth.login" }] },
			},
		}
		const ctx = await contextOf(optionsFor(withLogin(), { security }))
		expect(probeCredentials(ctx).recipe({ principal: "alpha", scheme: "bearer" })).toEqual({
			issue: "auth.login",
			kind: "login",
			refresh: "auth.login",
			revoke: "notes.list",
		})
	})

	it("leaves out a raw step no operation documents, or one on another origin, and reads a mint and a static", async () => {
		const elsewhere: SecurityConfig = {
			bearer: { login: { from: "$.t", steps: [{ method: "POST", origin: "idp", path: "/login" }] } },
		}
		const ctx = await contextOf(optionsFor(withLogin(), { security: { bearer: { static: "alpha-key" } } }))
		const probe = probeCredentials({ ...ctx, options: { ...ctx.options, security: elsewhere } })
		expect(probe.recipe({ principal: "alpha", scheme: "bearer" })).toEqual({ kind: "login" })
		const unknown: SecurityConfig = { bearer: { login: { from: "$.t", steps: [{ method: "GET", path: "/nowhere" }] } } }
		expect(
			probeCredentials({ ...ctx, options: { ...ctx.options, security: unknown } }).recipe({
				principal: "alpha",
				scheme: "bearer",
			}),
		).toEqual({ kind: "login" })
		expect(probeCredentials(ctx).recipe({ principal: "alpha", scheme: "bearer" })).toEqual({ kind: "static" })
		const keyed = await contextOf(
			optionsFor(keysApi(), { principals: { alpha: { scope: { project_id: "p1" } } }, security: MINTED }),
		)
		expect(probeCredentials(keyed).recipe({ principal: "alpha", scheme: "key" })).toEqual({
			issue: "keys.create",
			kind: "mint",
			revoke: "keys.revoke",
		})
	})
})

describe("probeCredentials: recipe, where nothing is declared", () => {
	it("names no issue for a login an out-of-band step completes, which calls no operation", async () => {
		const ctx = await contextOf(optionsFor(withLogin(), { security: LOGIN }))
		const otp = { outOfBand: { address: "a@x.test", as: "otp", kind: "otp" } } as const
		const security: SecurityConfig = { bearer: { login: { from: "otp", steps: [{ operationId: "auth.login" }, otp] } } }
		const probe = probeCredentials({ ...ctx, options: { ...ctx.options, security } })
		expect(probe.recipe({ principal: "alpha", scheme: "bearer" })).toEqual({ kind: "login" })
	})

	it("is untested for a principal the config does not name, or a scheme it has no recipe for", async () => {
		const ctx = await contextOf(optionsFor(withLogin(), { security: LOGIN }))
		const { security: _none, ...bare } = ctx.options
		expect(probeCredentials({ ...ctx, options: bare }).recipe({ principal: "alpha", scheme: "bearer" })).toEqual({
			untested: 'principal "alpha" has no recipe for the "bearer" scheme',
		})
		const probe = probeCredentials(ctx)
		expect(probe.recipe({ principal: "nobody", scheme: "bearer" })).toEqual({
			untested: 'no principal "nobody" in the config',
		})
		expect(probe.recipe({ principal: "alpha", scheme: "key" })).toEqual({
			untested: 'principal "alpha" has no recipe for the "key" scheme',
		})
	})
})
