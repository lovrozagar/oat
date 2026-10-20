import { describe, expect, it } from "vitest"
import { contextOf, notesApi, optionsFor } from "./__fixtures__/api.ts"
import { actingOf } from "./acting.ts"

/* Who a principal is, and what it would send on an operation: what a hook is told in place of headers. */

describe("actingOf", () => {
	it("resolves the bearer credential and its placement a jwt-secured operation would carry", async () => {
		const ctx = await contextOf(optionsFor(notesApi(), { principals: { alpha: { email: "a@x.test", tenant: "t1" } } }))
		const acting = actingOf(ctx, "alpha")
		expect(acting.identity).toEqual({ email: "a@x.test" })
		expect(await acting.sending("notes.get")).toEqual({
			credential: "alpha-key",
			sends: { cookies: {}, headers: { Authorization: "Bearer alpha-key" }, query: {} },
		})
	})

	it("sends nothing it could name for an operation open to anyone, or one it cannot meet", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		expect(await actingOf(ctx, "alpha").sending("nope.op")).toBeUndefined()
		const { security: _none, ...bare } = optionsFor(notesApi())
		expect(await actingOf(await contextOf(bare), "alpha").sending("notes.get")).toBeUndefined()
	})
})
