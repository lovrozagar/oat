import { describe, expect, it } from "vitest"
import { api } from "../__fixtures__/api.ts"

const CARD = { kind: "card", last4: "4242" }
const BANK = { account: "DE89370400440532013000", kind: "bank" }

describe("the search route", () => {
	it("answers a QUERY with the card or bank account its body names, as it was asked", async () => {
		const { call } = await api()
		for (const body of [CARD, BANK]) {
			expect(await call("QUERY", "/v1/search", { body, token: null })).toMatchObject({ body, status: 200 })
		}
	})

	it("refuses a body whose fields fit the other kind than its tag names, or no kind at all", async () => {
		const { call } = await api()
		const mismatched = [
			{ kind: "card", account: BANK.account },
			{ kind: "bank", last4: CARD.last4 },
			{ kind: "wallet", last4: CARD.last4 },
			{ last4: CARD.last4 },
		]
		for (const body of mismatched) {
			const answer = await call("QUERY", "/v1/search", { body, token: null })
			expect(answer).toMatchObject({ body: { error_key: "invalid_input" }, status: 400 })
		}
	})

	it("refuses a branch's own field missing, malformed or joined by another, and a body that is not an object", async () => {
		const { call } = await api()
		const invalid = [
			{ kind: "card" },
			{ kind: "card", last4: "42a2" },
			{ kind: "card", last4: 4242 },
			{ ...CARD, extra: 1 },
			{ account: "", kind: "bank" },
			{ account: "x".repeat(35), kind: "bank" },
			{ ...BANK, last4: CARD.last4 },
		]
		for (const body of invalid) expect((await call("QUERY", "/v1/search", { body, token: null })).status).toBe(400)
		for (const raw of ["[1]", "3", "null"]) {
			expect((await call("QUERY", "/v1/search", { body: raw, token: null })).status).toBe(400)
		}
		expect((await call("QUERY", "/v1/search", { form: "kind=card", token: null })).status).toBe(415)
	})

	it("answers the other branch's tag over the asked fields under DISCRIMINATOR_BRANCH_WRONG", async () => {
		const { call } = await api({ defects: ["DISCRIMINATOR_BRANCH_WRONG"] })
		expect((await call("QUERY", "/v1/search", { body: CARD, token: null })).body).toEqual({ ...CARD, kind: "bank" })
		expect((await call("QUERY", "/v1/search", { body: BANK, token: null })).body).toEqual({ ...BANK, kind: "card" })
	})

	it("is no route for GET", async () => {
		expect((await (await api()).call("GET", "/v1/search")).status).toBe(404)
	})
})
