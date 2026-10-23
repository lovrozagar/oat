import { describe, expect, it } from "vitest"
import { accountsApi, accountsState } from "./__fixtures__/accounts.ts"
import { contextOf, EMAIL_LOGIN, optionsFor } from "./__fixtures__/api.ts"
import { teardownAccounts } from "./accounts.ts"
import { checkAccounts } from "./check-accounts.ts"
import type { RunOptions } from "./types.ts"

/*
 * A check that signs an account up reads it back as that account: held as teardown holds it, so
 * teardown removes it as the same principal, and never with a credential that is not its own.
 */

/* A signup whose answer names nothing. */
const QUIET = { "x-quiet": "1" }

/** A run of alpha that sent `body` to the signup as a check would, what it answered, and the self read. */
async function signedUp(
	body: Record<string, unknown>,
	{ headers = {}, options = {} }: { headers?: Record<string, string>; options?: Partial<RunOptions> } = {},
) {
	const state = accountsState()
	const ctx = await contextOf(
		optionsFor(accountsApi(state), {
			principals: { alpha: { email: "alpha@x.test" } },
			security: EMAIL_LOGIN,
			...options,
		}),
	)
	const answer = await ctx.client.request("POST", "/signup", {
		as: { anonymous: true },
		body,
		headers,
		operationId: "auth.signup",
	})
	const read = ctx.model.byOperationId.get("me.read")
	if (read === undefined) throw new Error("the accounts document has a self read")
	return { answer, ctx, read, state }
}

const PROBE = { email: "probe@x.test", password: "pw-123456" }

describe("checkAccounts: the account a check's own sign-up made", () => {
	it("holds it as the principal teardown holds it as, so the read is the account's own and teardown removes it", async () => {
		const { answer, ctx, read, state } = await signedUp(PROBE)
		expect(await checkAccounts(ctx).signIn(answer, read)).toEqual({ principal: "account-1" })
		const own = await ctx.client.request("GET", "/me", { as: { principal: "account-1" }, operationId: "me.read" })
		expect(own.responseBody).toEqual({ email: "probe@x.test" })
		await teardownAccounts(ctx)
		expect(ctx.accounts.entries()[0]).toMatchObject({ principal: "account-1", status: "removed" })
		expect(state.removed).toEqual(["probe@x.test"])
	})

	it("names no principal for an exchange the ledger holds no account of", async () => {
		const { answer, ctx, read } = await signedUp(PROBE)
		const other = await ctx.client.request("GET", "/me", { as: { principal: "alpha" }, operationId: "me.read" })
		expect(await checkAccounts(ctx).signIn({ ...answer, seq: other.seq }, read)).toEqual({
			untested: `the run's ledger holds no account auth.signup #${other.seq} made`,
		})
	})
})

describe("checkAccounts: an account it may not read as", () => {
	it("refuses an account whose name a configured principal holds, which this run did not make", async () => {
		const { answer, ctx, read } = await signedUp({ ...PROBE, email: "alpha@x.test" })
		expect(await checkAccounts(ctx).signIn(answer, read)).toEqual({
			untested: "its name is configured principal alpha's, which this run did not make",
		})
	})

	it("refuses an account it holds no credential for", async () => {
		const { answer, ctx, read } = await signedUp({ ...PROBE, email: "nologin@x.test" }, { headers: QUIET })
		expect(await checkAccounts(ctx).signIn(answer, read)).toEqual({
			untested: "the run holds no credential for the account nologin@x.test",
		})
	})

	it("refuses a credential that is not the account's own, as teardown does", async () => {
		const { answer, ctx, read } = await signedUp(PROBE, {
			options: { security: { bearer: { static: "login-alpha@x.test" } } },
		})
		expect(await checkAccounts(ctx).signIn(answer, read)).toEqual({
			untested:
				"me.read is not sent as the account: its bearer credential comes from a static recipe, the configured principals' own",
		})
	})
})
