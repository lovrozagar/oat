import { describe, expect, it } from "vitest"
import type { AuthStep } from "../../config/types/steps.ts"
import { accountsApi, accountsDoc, type AccountsState, accountsState } from "./__fixtures__/accounts.ts"
import { contextOf, EMAIL_LOGIN, notesApi, optionsFor, withLogin, withSignup } from "./__fixtures__/api.ts"
import { accountReport, teardownAccounts } from "./accounts.ts"
import type { RunContext } from "./context.ts"
import type { RunOptions } from "./types.ts"

/*
 * Every account the run made is removed, as itself first, then by an admin, then by the hook; what
 * none of them removes is a leftover named by its email. An account a configured principal holds,
 * that the run did not make, is never removed.
 */

/** A run whose `fresh` principal signs up on `respond`, then signs in by email. */
function freshRun(respond = withSignup(() => ({ status: 201 })), extra: Partial<RunOptions> = {}) {
	return contextOf(
		optionsFor(respond, {
			principals: { alpha: { email: "alpha@x.test" }, fresh: { fresh: true } },
			security: EMAIL_LOGIN,
			...extra,
		}),
	)
}

/** The fresh principal's account, as the ledger and the report end up with it. */
async function torn(ctx: RunContext) {
	await teardownAccounts(ctx)
	const [entry] = ctx.accounts.entries()
	return { entry, failed: ctx.state.teardown?.failed ?? [], records: ctx.state.teardown?.records ?? [] }
}

const emailOf = (ctx: RunContext): string => String(ctx.principals.byId.get("fresh")?.identity["email"])

describe("teardownAccounts, as the account itself", () => {
	it("removes an account by the document's delete-self, sent as the account", async () => {
		const state = accountsState()
		const ctx = await freshRun(accountsApi(state))
		const { entry, failed, records } = await torn(ctx)
		expect(entry).toMatchObject({ note: "deleted itself by me.delete (204)", principal: "fresh", status: "removed" })
		expect(state.removed).toEqual([emailOf(ctx)])
		expect(failed).toEqual([])
		expect(records).toEqual([{ entity: "account", id: emailOf(ctx), principal: "fresh", removed: true }])
		expect(ctx.state.teardown?.removed).toBe(1)
	})

	it("counts an account gone when its delete-self answers 404, and an account that deleted itself during the run", async () => {
		const state: AccountsState = { ...accountsState(), selfStatus: 404 }
		const ctx = await freshRun(accountsApi(state))
		expect((await torn(ctx)).entry?.status).toBe("removed")
		const early = await freshRun(accountsApi(accountsState()))
		await early.client.request("DELETE", "/me", { as: { principal: "fresh" }, operationId: "me.delete" })
		const { entry } = await torn(early)
		expect(entry?.note).toMatch(/^deleted itself during the run \(me\.delete #\d+\)$/)
	})
})

describe("teardownAccounts never deletes as someone else", () => {
	it("sends no delete-self with a credential a configured principal holds too, and removes the account by an admin", async () => {
		const state = accountsState()
		const ctx = await contextOf(
			optionsFor(accountsApi(state, accountsDoc({ adminDelete: true })), {
				principals: { alpha: { email: "alpha@x.test" } },
				security: { bearer: { static: "login-alpha@x.test" } },
			}),
		)
		const body = { email: "made@x.test", password: "pw-123456" }
		await ctx.client.request("POST", "/signup", { as: { anonymous: true }, body, operationId: "auth.signup" })
		ctx.store.enroll("disposable-0", { ...body })
		await ctx.client.request("GET", "/me", { as: { principal: "disposable-0" }, operationId: "me.read" })
		await teardownAccounts(ctx)
		expect(ctx.client.transcript.filter((exchange) => exchange.operationId === "me.delete")).toEqual([])
		expect(state.removed).toEqual(["made@x.test"])
		expect(ctx.accounts.entries()[0]?.note).toBe("deleted by member.delete as alpha (204)")
	})
})

describe("teardownAccounts never deletes as someone else, by its credential", () => {
	it("sends no delete-self when the account's credential is another principal's too", async () => {
		const state = accountsState()
		const api = accountsApi(state, accountsDoc({ adminDelete: true }))
		/* A login that answers everyone with alpha's token. */
		const sameToken: typeof api = (method, path, request) =>
			path === "/login" ? { body: { access_token: "login-alpha@x.test" }, status: 200 } : api(method, path, request)
		const ctx = await contextOf(
			optionsFor(sameToken, { principals: { alpha: { email: "alpha@x.test" } }, security: EMAIL_LOGIN }),
		)
		const body = { email: "made@x.test", password: "pw-123456" }
		await ctx.client.request("POST", "/signup", {
			as: { anonymous: true },
			body,
			headers: QUIET,
			operationId: "auth.signup",
		})
		await teardownAccounts(ctx)
		expect(ctx.client.transcript.filter((exchange) => exchange.operationId === "me.delete")).toEqual([])
		expect(ctx.accounts.entries()[0]?.note).toBe(
			"me.delete was not sent: its credential is alpha's, so it would delete that account instead",
		)
	})
})

describe("teardownAccounts when a removal cannot be sent", () => {
	it("goes on to the next way, saying why the one before was not sent", async () => {
		const state = accountsState()
		const api = accountsApi(state, accountsDoc({ adminDelete: true }))
		const ctx = await freshRun((method, path, request) => {
			if (method === "DELETE" && path === "/me") throw new Error("socket closed")
			return api(method, path, request)
		})
		const { entry } = await torn(ctx)
		expect(entry?.note).toBe("deleted by member.delete as alpha (204)")
		const [tried] = ctx.client.transcript.filter((exchange) => exchange.operationId === "me.delete")
		expect(tried).toBeUndefined()
	})
})

describe("teardownAccounts, by an admin", () => {
	it("goes straight to the admin delete when the document has no delete-self", async () => {
		const ctx = await freshRun(accountsApi(accountsState(), accountsDoc({ adminDelete: true, deleteSelf: false })))
		expect((await torn(ctx)).entry?.note).toBe("deleted by member.delete as alpha (204)")
	})

	it("deletes by the account's id, as the strongest configured principal, when its delete-self is refused", async () => {
		const state: AccountsState = { ...accountsState(), selfStatus: 403 }
		const ctx = await freshRun(accountsApi(state, accountsDoc({ adminDelete: true })))
		const { entry } = await torn(ctx)
		expect(entry).toMatchObject({ id: `m-${emailOf(ctx)}`, note: "deleted by member.delete as alpha (204)" })
	})

	it("leaves the account, saying what each way answered, when the admin is refused too", async () => {
		const state: AccountsState = { ...accountsState(), adminStatus: 403, selfStatus: 500 }
		const ctx = await freshRun(accountsApi(state, accountsDoc({ adminDelete: true })))
		const { entry, failed } = await torn(ctx)
		expect(entry?.status).toBe("left")
		expect(failed).toEqual([
			{
				entity: "account",
				id: emailOf(ctx),
				principal: "fresh",
				reason: "me.delete as the account answered 500; member.delete as alpha answered 403",
			},
		])
	})
})

describe("teardownAccounts, by the hook", () => {
	it("hands the hook the account's address and its credential as its scheme places it", async () => {
		const removed: unknown[] = []
		const ctx = await freshRun(undefined, {
			hooks: { teardownPrincipal: async (address, held) => void removed.push([address, held]) },
		})
		const { entry } = await torn(ctx)
		const email = emailOf(ctx)
		expect(entry).toMatchObject({ note: "removed by hooks.teardownPrincipal", status: "removed" })
		expect(removed).toEqual([
			[
				email,
				{
					credential: `login-${email}`,
					sends: { cookies: {}, headers: { Authorization: `Bearer login-${email}` }, query: {} },
				},
			],
		])
	})

	it("names the account a leftover with no way to remove it, a hook that threw, or nothing to hand the hook", async () => {
		const bare = await torn(await freshRun())
		expect(bare.failed[0]?.reason).toBe("the document has no delete-self, and no hooks.teardownPrincipal is configured")
		const failing = await torn(
			await freshRun(undefined, {
				hooks: {
					teardownPrincipal: async () => {
						throw new Error("cannot delete")
					},
				},
			}),
		)
		expect(failing.failed[0]?.reason).toBe("hooks.teardownPrincipal threw: cannot delete")
		const keyless = await torn(
			await freshRun(undefined, {
				hooks: { teardownPrincipal: async () => undefined },
				principals: { alpha: { email: "alpha@x.test" }, fresh: { fresh: true, security: { bearer: { static: "s" } } } },
			}),
		)
		expect(keyless.failed[0]?.reason).toBe("hooks.teardownPrincipal needs a credential the run holds for it")
	})
})

/** What the hook removed, by a run whose principals are `principals`. */
async function removedBy(principals: RunOptions["principals"], respond = withSignup(() => ({ status: 201 }))) {
	const removed: string[] = []
	const ctx = await contextOf(
		optionsFor(respond, {
			hooks: { teardownPrincipal: async (address, held) => void removed.push(`${address} ${held.credential}`) },
			principals,
			security: EMAIL_LOGIN,
		}),
	)
	await teardownAccounts(ctx)
	return { failed: ctx.state.teardown?.failed ?? [], removed }
}

describe("teardownAccounts: only what the run made", () => {
	it("removes a principal whose login registers it by the marked operation", async () => {
		const steps: [AuthStep, ...AuthStep[]] = [
			{ body: { email: "{principal.email}", password: "p4ssw0rd!", tenant: "t1" }, operationId: "auth.signup" },
			{ body: { email: "{principal.email}" }, operationId: "auth.login" },
		]
		const security = { bearer: { login: { from: "$.access_token", steps } } }
		expect(await removedBy({ alpha: { email: "reg@x.test", security } })).toEqual({
			failed: [],
			removed: ["reg@x.test login-reg@x.test"],
		})
	})

	it("removes a principal declared created, and never a configured one whose login binds and answers an email", async () => {
		expect((await removedBy({ alpha: { created: true, email: "c@x.test" } })).removed).toEqual([
			"c@x.test login-c@x.test",
		])
		const binding: [AuthStep] = [
			{ bind: { address: "{principal.email}" }, body: { email: "{principal.email}" }, operationId: "auth.login" },
		]
		const kept = await removedBy(
			{ alpha: { email: "a@x.test", security: { bearer: { login: { from: "$.token", steps: binding } } } } },
			withLogin(),
		)
		expect(kept).toEqual({ failed: [], removed: [] })
	})

	it("names a created principal it has no address for by how it was made, rather than calling the hook without one", async () => {
		const nameless = await removedBy({ alpha: { created: true, security: { bearer: { static: "s" } } } })
		expect(nameless).toEqual({
			failed: [
				{
					entity: "account",
					id: "#1 by (declared created)",
					principal: "alpha",
					reason: "hooks.teardownPrincipal needs an address to name it by",
				},
			],
			removed: [],
		})
	})

	it("never removes an account whose name a configured principal holds, though a sign-up answered 2xx for it", async () => {
		const state = accountsState()
		const ctx = await contextOf(
			optionsFor(accountsApi(state), { principals: { alpha: { email: "alpha@x.test" } }, security: EMAIL_LOGIN }),
		)
		const body = { email: "alpha@x.test", password: "pw-123456" }
		await ctx.client.request("POST", "/signup", { as: { anonymous: true }, body, operationId: "auth.signup" })
		const { entry } = await torn(ctx)
		expect(entry).toMatchObject({ principal: "alpha", status: "left" })
		expect(entry?.note).toMatch(/^its name is configured principal alpha's, which this run did not make/)
		expect(state.removed).toEqual([])
	})
})

/* A signup answers no credential, but alpha's own. */
const quiet = (state: AccountsState) => {
	const api = accountsApi(state)
	return (method: string, path: string, request: Parameters<typeof api>[2]) => {
		const answer = api(method, path, request)
		const email = (request.body as { email?: string } | undefined)?.email
		return path === "/signup" && email !== "a@x.test" ? { status: 201 } : answer
	}
}

describe("teardownAccounts on an account no principal holds", () => {
	it("signs in as it from its own sign-up's answer, and removes it as itself", async () => {
		const state = accountsState()
		const ctx = await contextOf(
			optionsFor(accountsApi(state), { principals: { alpha: { email: "alpha@x.test" } }, security: EMAIL_LOGIN }),
		)
		const body = { email: "probe@x.test", password: "pw-123456" }
		await ctx.client.request("POST", "/signup", { as: { anonymous: true }, body, operationId: "auth.signup" })
		const { entry } = await torn(ctx)
		expect(entry).toMatchObject({ principal: "account-1", status: "removed" })
		expect(state.removed).toEqual(["probe@x.test"])
	})

	it("signs in by its recipe when the answer carries no credential, and never by one that signs up again", async () => {
		const state = accountsState()
		const ctx = await contextOf(
			optionsFor(quiet(state), { principals: { alpha: { email: "alpha@x.test" } }, security: EMAIL_LOGIN }),
		)
		const body = { email: "quiet@x.test", password: "pw-123456" }
		await ctx.client.request("POST", "/signup", { as: { anonymous: true }, body, operationId: "auth.signup" })
		expect((await torn(ctx)).entry).toMatchObject({ principal: "account-1", status: "removed" })
		const signingUp = {
			bearer: {
				login: {
					from: "$.access_token",
					steps: [{ body: { email: "{principal.email}", password: "p4ssw0rd!" }, operationId: "auth.signup" }] as [
						AuthStep,
					],
				},
			},
		}
		const again = await contextOf(
			optionsFor(quiet(accountsState()), { principals: { alpha: { email: "a@x.test" } }, security: signingUp }),
		)
		await again.client.request("POST", "/signup", {
			as: { anonymous: true },
			body: { email: "other@x.test", password: "pw-123456" },
			operationId: "auth.signup",
		})
		await torn(again)
		expect(again.accounts.entries().map((entry) => entry.status)).toEqual(["removed", "left"])
	})
})

/* A signup whose answer names nothing. */
const QUIET = { "x-quiet": "1" }

/** A run of alpha and beta, signing in by email unless `extra` says otherwise, that sent `bodies` to the signup. */
async function sentUp(bodies: unknown[], extra: Partial<RunOptions> = {}, headers: Record<string, string> = {}) {
	const state = accountsState()
	const options = optionsFor(accountsApi(state, accountsDoc({ adminDelete: true })), {
		principals: { alpha: { email: "alpha@x.test", rank: 2 }, beta: { email: "beta@x.test", rank: 1 } },
		security: EMAIL_LOGIN,
		...extra,
	})
	/* An empty `security` in `extra` stands for none at all. */
	if (Object.keys(options.security ?? {}).length === 0) delete options.security
	const ctx = await contextOf(options)
	for (const body of bodies) {
		await ctx.client.request("POST", "/signup", { as: { anonymous: true }, body, headers, operationId: "auth.signup" })
	}
	await teardownAccounts(ctx)
	return { ctx, state }
}

describe("teardownAccounts on an account it cannot sign in as", () => {
	it("leaves one its recipe refuses and no admin can name, telling the hook it holds no credential for it", async () => {
		const body = { email: "nologin@x.test", password: "pw-123456" }
		const { ctx } = await sentUp([body], { hooks: { teardownPrincipal: async () => undefined } }, QUIET)
		expect(ctx.accounts.entries()[0]).toMatchObject({
			note:
				"me.delete needs the account signed in, and the run holds no credential for it; " +
				"hooks.teardownPrincipal needs a credential the run holds for it",
			status: "left",
		})
	})

	it("leaves one whose sign-up sent no object, or never answered, with nothing to sign in by", async () => {
		const { ctx } = await sentUp([["a@x.test"]], {}, QUIET)
		expect(ctx.accounts.entries()[0]).toMatchObject({ status: "left" })
		const api = accountsApi(accountsState())
		const dropped = await contextOf(
			optionsFor(
				(method, path, request) => {
					if (path === "/signup") throw new Error("connection reset")
					return api(method, path, request)
				},
				{ principals: { alpha: { email: "alpha@x.test" } }, security: EMAIL_LOGIN },
			),
		)
		const body = { email: "lost@x.test", password: "pw-123456" }
		await dropped.client
			.request("POST", "/signup", { as: { anonymous: true }, body, operationId: "auth.signup" })
			.catch(() => undefined)
		expect(dropped.accounts.entries()[0]?.status).toBe("sending")
		await teardownAccounts(dropped)
		expect(dropped.state.teardown?.failed).toEqual([
			{
				entity: "account",
				id: "lost@x.test",
				principal: "(none)",
				reason: "me.delete needs the account signed in, and the run holds no credential for it",
			},
		])
	})

	it("deletes one its recipe refuses by the id its sign-up sent, as the strongest admin", async () => {
		const body = { email: "nologin@x.test", member_id: "m-x", password: "pw-123456" }
		const { ctx } = await sentUp([body], {}, QUIET)
		expect(ctx.accounts.entries()[0]).toMatchObject({ id: "m-x", status: "removed" })
		expect(ctx.accounts.entries()[0]?.note).toBe("deleted by member.delete as alpha (204)")
	})

	it("holds it with no recipe when the run has no security, and says its delete-self could not be sent", async () => {
		const body = { email: "open@x.test", password: "pw-123456" }
		const { ctx, state } = await sentUp([body], { security: {} }, QUIET)
		expect(ctx.accounts.entries()[0]).toMatchObject({ principal: "account-1", status: "left" })
		expect(ctx.accounts.entries()[0]?.note).toMatch(/^me\.delete as the account was not sent: /)
		expect(state.removed).toEqual([])
	})
})

describe("teardownAccounts, what it leaves alone", () => {
	it("leaves the accounts to the primary run, and has nothing to do when the run made none", async () => {
		const secondary = await freshRun(undefined, { skipPrincipalTeardown: true })
		await teardownAccounts(secondary)
		expect(secondary.accounts.owed()).toHaveLength(1)
		const plain = await contextOf(optionsFor(notesApi(), {}))
		await teardownAccounts(plain)
		expect([secondary.state.teardown, plain.state.teardown]).toEqual([null, null])
	})

	it("names the account a leftover, and the run blocked, when removing it threw", async () => {
		const ctx = await freshRun(undefined, { hooks: { teardownPrincipal: async () => undefined } })
		const broken = { ...ctx, store: { ...ctx.store, snapshot: () => Promise.reject(new Error("store gone")) } }
		await teardownAccounts(broken)
		expect(ctx.accounts.entries()[0]?.note).toBe("teardown stopped on an unexpected error: store gone")
		expect(ctx.findings.findings.map((finding) => [finding.check, finding.verdict])).toEqual([
			["world.teardown", "BLOCKED"],
		])
	})
})

describe("accountReport", () => {
	it("lists every account, removed or not, and names one with no identity by how it was made", () => {
		const report = accountReport([
			{ identity: { email: "a@x.test" }, n: 1, operationId: "auth.signup", principal: "p", status: "removed" },
			{ identity: {}, n: 2, operationId: "auth.signup", status: "sending" },
		])
		expect(report).toEqual({
			failed: [{ entity: "account", id: "#2 by auth.signup", principal: "(none)", reason: "teardown did not run" }],
			records: [
				{ entity: "account", id: "a@x.test", principal: "p", removed: true },
				{ entity: "account", id: "#2 by auth.signup", principal: "(none)", removed: false },
			],
			removed: 1,
			unidentified: [],
			unsupported: [],
		})
	})
})
