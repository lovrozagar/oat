import { describe, expect, it } from "vitest"
import { accountsApi, accountsDoc, accountsState } from "../run/__fixtures__/accounts.ts"
import { contextOf, EMAIL_LOGIN, optionsFor } from "../run/__fixtures__/api.ts"

/* The run's client ledgers each account-making request as it goes, and an account that deleted itself. */

async function run(doc = accountsDoc({ adminDelete: true })) {
	const state = accountsState()
	const ctx = await contextOf(
		optionsFor(accountsApi(state, doc), { principals: { alpha: { email: "alpha@x.test" } }, security: EMAIL_LOGIN }),
	)
	const signUp = (body: unknown) =>
		ctx.client.request("POST", "/signup", { as: { anonymous: true }, body, operationId: "auth.signup" })
	return { ctx, signUp }
}

describe("watchAccounts", () => {
	it("ledgers a sign-up by the names it sent, with the id an admin delete would take, as answered", async () => {
		const { ctx, signUp } = await run()
		await signUp({ email: "a@x.test", password: "pw-123456" })
		expect(ctx.accounts.entries()).toEqual([
			{ id: "m-a@x.test", identity: { email: "a@x.test" }, n: 1, operationId: "auth.signup", status: "created" },
		])
	})

	it("takes the id as sent when the answer has none, and none when neither does or the body is no object", async () => {
		const { ctx } = await run()
		const quiet = (body: unknown) =>
			ctx.client.request("POST", "/signup", {
				as: { anonymous: true },
				body,
				headers: { "x-quiet": "1" },
				operationId: "auth.signup",
			})
		await quiet({ email: "b@x.test", member_id: "m-sent" })
		await quiet({ email: "c@x.test" })
		await quiet("not an object")
		expect(ctx.accounts.entries().map((entry) => entry.id)).toEqual(["m-sent", undefined, undefined])
	})

	it("ledgers no id where the sign-up creates no entity an admin can delete, and nothing for a read or another write", async () => {
		const { ctx, signUp } = await run(accountsDoc())
		await signUp({ email: "a@x.test", password: "pw-123456" })
		await ctx.client.request("GET", "/me", { as: { principal: "alpha" }, operationId: "me.read" })
		await ctx.client.request("POST", "/notes", { as: { principal: "alpha" }, body: { title: "t" } })
		await ctx.client.request("DELETE", "/me", { as: { anonymous: true }, operationId: "me.delete" })
		expect(ctx.accounts.entries()).toEqual([
			{ identity: { email: "a@x.test" }, n: 1, operationId: "auth.signup", status: "created" },
		])
	})

	it("marks the account removed when it deleted itself, and not when the delete was refused", async () => {
		const { ctx, signUp } = await run()
		await signUp({ email: "alpha@x.test", password: "pw-123456" })
		await signUp({ email: "other@x.test", password: "pw-123456" })
		const asAlpha = { as: { principal: "alpha" }, operationId: "me.delete" }
		await ctx.client.request("DELETE", "/me", asAlpha)
		expect(ctx.accounts.entries().map((entry) => [entry.identity["email"], entry.status, entry.principal])).toEqual([
			["alpha@x.test", "removed", "alpha"],
			["other@x.test", "created", undefined],
		])
		expect(ctx.accounts.entries()[0]?.note).toMatch(/^deleted itself during the run \(me\.delete #\d+\)$/)
		await ctx.client.request("DELETE", "/me", asAlpha)
		expect(ctx.accounts.entries()[1]?.status).toBe("created")
	})
})
