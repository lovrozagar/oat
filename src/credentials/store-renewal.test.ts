import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../config/types/security.ts"
import { answerOf, BEARER, fakePorts } from "./__fixtures__/ports.ts"
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
