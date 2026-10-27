import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../config/types/security.ts"
import { answerOf, BEARER, fakePorts, NOW } from "./__fixtures__/ports.ts"
import { SCHEMES } from "./__fixtures__/store.ts"
import { type Credential, createStore, type Held } from "./store.ts"

/*
 * A renewal per refused value, and a block that outlasts it. A server may issue the very value it
 * refused, a token derived from the account say: a value is renewed once however many requests it was
 * refused for, before or after that renewal settled. A block holds for every scope until a credential
 * is adopted.
 */

const LOGIN = { jwt: { login: { from: "$.token", steps: [{ operationId: "auth.login" }] } } } as SecurityConfig

/** A store whose every login answers `token`, counting the logins. */
function storeAnswering(token: (login: number) => string) {
	const counted = { logins: 0 }
	const { ports } = fakePorts({
		run: async () => ({ answer: answerOf({ token: token(++counted.logins) }), scope: {} }),
	})
	const store = createStore({ ports, principals: { ann: {} }, schemes: new Map([["jwt", BEARER]]), security: LOGIN })
	return { counted, store }
}

const ann = { principal: "ann", scheme: "jwt" }
const valueOf = (held: Held): string => (held as Credential).value

describe("createStore: a value renewed once", () => {
	it("renews a refused value once, even when the server issues that same value again", async () => {
		const { counted, store } = storeAnswering(() => "tok_ann")
		await store.acquire(ann)
		const first = await store.refresh({ ...ann, sentValue: "tok_ann" })
		const later = await store.refresh({ ...ann, sentValue: "tok_ann" })
		expect([valueOf(first), valueOf(later), counted.logins]).toEqual(["tok_ann", "tok_ann", 2])
	})

	it("renews a value its renewal issued that differs, as a new refusal", async () => {
		const { counted, store } = storeAnswering((login) => `tok-${login}`)
		await store.acquire(ann)
		expect(valueOf(await store.refresh({ ...ann, sentValue: "tok-1" }))).toBe("tok-2")
		expect(valueOf(await store.refresh({ ...ann, sentValue: "tok-2" }))).toBe("tok-3")
		expect(counted.logins).toBe(3)
	})
})

describe("createStore: block", () => {
	it("blocks the principal × scheme for every scope, with the reason, until a credential is adopted", async () => {
		const { store } = storeAnswering(() => "tok_ann")
		store.block({ ...ann, scopes: ["a"] }, "refused")
		expect(await store.acquire(ann)).toEqual({ blocked: "refused" })
		expect(await store.refresh({ ...ann, sentValue: "tok_ann" })).toEqual({ blocked: "refused" })
		expect(valueOf(await store.adopt({ ...ann, value: "fresh" }))).toBe("fresh")
	})
})

/* A login that saves its refresh token, and a refresh that reads it; ann's account is the run's own. */
function rotating(refuseRefresh = false) {
	const security: SecurityConfig = {
		jwt: {
			expiresIn: 60,
			login: { from: "$.token", steps: [{ operationId: "auth.login", saveAs: { refresh_token: "$.refresh" } }] },
			refresh: { from: "$.token", steps: [{ body: { token: "{refresh_token}" }, operationId: "auth.refresh" }] },
		},
	}
	let issued = 0
	const { ports, recorded } = fakePorts({
		run: (call) => {
			const refreshing = "operationId" in call.steps[0]! && call.steps[0].operationId === "auth.refresh"
			if (refreshing && refuseRefresh) return Promise.reject(new Error("auth step 1 answered 401"))
			issued++
			return Promise.resolve({
				answer: answerOf({ refresh: "r1", token: `ann-${issued}` }),
				scope: { refresh_token: "r1" },
			})
		},
	})
	const clock = { now: NOW }
	const principals = { ann: { created: true, email: "ann@x.io" } }
	const store = createStore({ now: () => clock.now, ports, principals, schemes: SCHEMES, security })
	const steps = () => recorded.runs.map((run) => [(run.steps[0] as { operationId: string }).operationId, run.scope])
	return { clock, steps, store }
}

describe("createStore: an adopted credential its refresh cannot renew", () => {
	it("renews the principal's own session it replaced, never signing in again", async () => {
		const { clock, steps, store } = rotating()
		await store.acquire({ principal: "ann", scheme: "jwt" })
		await store.adopt({ principal: "ann", scheme: "jwt", value: "invited" })
		clock.now += 120_000
		expect(valueOf(await store.acquire({ principal: "ann", scheme: "jwt" }))).toBe("ann-2")
		expect(steps()).toEqual([
			["auth.login", {}],
			["auth.refresh", { credential: "ann-1", refresh_token: "r1" }],
		])
	})

	it("blocks a principal the run created when its refresh fails, rather than signing it up again", async () => {
		const { clock, steps, store } = rotating(true)
		await store.acquire({ principal: "ann", scheme: "jwt" })
		clock.now += 120_000
		expect(await store.acquire({ principal: "ann", scheme: "jwt" })).toEqual({
			blocked: "refresh for ann/jwt: auth step 1 answered 401",
		})
		expect(steps().map(([operation]) => operation)).toEqual(["auth.login", "auth.refresh"])
	})
})
