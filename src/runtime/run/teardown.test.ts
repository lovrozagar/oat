import { describe, expect, it } from "vitest"
import type { AuthStep } from "../../config/types/steps.ts"
import type { ProgressSnapshot } from "../progress/types.ts"
import { createdId } from "../proven-id.ts"
import type { Record_ } from "../world/records.ts"
import type { Answer } from "../checks/__fixtures__/harness.ts"
import {
	contextOf,
	EMAIL_LOGIN,
	notesApi,
	notesDoc,
	optionsFor,
	overriding,
	withLogin,
	withSignup,
} from "./__fixtures__/api.ts"
import type { SecurityConfig } from "../../config/types/security.ts"
import { keysApi, MINTED } from "./__fixtures__/keys.ts"
import type { RunContext } from "./context.ts"
import {
	reportUnremovable,
	revokeCredentials,
	revokeSessions,
	teardownPrincipals,
	trackCreates,
	unwind,
} from "./teardown.ts"
import type { RunOptions } from "./types.ts"
import { anonymousOperationOpen } from "../checks/families/security/auth-anonymous-operation-open.ts"
import { runWriteSecurity } from "./security.ts"

/*
 * What the run made, it removes: every create a principal sent is ledgered as it, the ledger
 * unwinds after the checks and again after the scenarios, the keys it minted are revoked, and
 * accounts the run signed up go last — or are named as left behind.
 */

const AS_ALPHA = { as: { principal: "alpha" } }

/** A run whose `fresh` principal signs up as `signup` answers, then signs in by email. */
function freshRun(extra: Partial<RunOptions> = {}, signup: () => Answer = () => ({ status: 201 })) {
	return contextOf(
		optionsFor(withSignup(signup), {
			principals: { alpha: { email: "alpha@x.test" }, fresh: { fresh: true } },
			security: EMAIL_LOGIN,
			...extra,
		}),
	)
}

const id = (value: string) => createdId(value) as NonNullable<ReturnType<typeof createdId>>

async function contextWith(rows: Record_[], extra: Partial<RunOptions> = {}): Promise<RunContext> {
	return contextOf(optionsFor(notesApi(notesDoc(), rows), extra))
}

/** Ledgers `count` notes the API holds, as the first principal. */
function seed(ctx: RunContext, rows: Record_[], count: number): void {
	const owner = ctx.principals.ownerOf(ctx.principals.alpha)
	for (let index = 1; index <= count; index++) {
		rows.push({ id: `n${index}`, title: `t${index}` })
		ctx.principals.recorder(owner)("note", id(`n${index}`), {})
	}
}

async function verifyRemoved(): Promise<never> {
	throw new Error("hook down")
}

describe("trackCreates", () => {
	it("ledgers a create a principal sent, and marks its identity taken", async () => {
		const rows: Record_[] = []
		const ctx = await contextWith(rows)
		const taken = new Set<string>()
		ctx.state.takenByEntity.set("note", taken)
		trackCreates(ctx)
		await ctx.client.request("POST", "/notes", { ...AS_ALPHA, body: { title: "x" } })
		expect(ctx.ledger.size).toBe(1)
		expect(taken).toEqual(new Set([String(rows[0]?.id)]))
	})

	it("ledgers a create of an entity no seeding has started", async () => {
		const ctx = await contextWith([])
		trackCreates(ctx)
		await ctx.client.request("POST", "/notes", { ...AS_ALPHA, body: { title: "x" } })
		expect(ctx.ledger.size).toBe(1)
	})
})

/* An open register that ignores its body, as a broken API does, and answers `answer` having made note r1. */
async function openRegister(answer: Record<string, unknown>) {
	const rows: Record_[] = []
	const register = {
		post: {
			operationId: "notes.register",
			requestBody: {
				content: {
					"application/json": {
						schema: { properties: { email: { type: "string" } }, required: ["email"], type: "object" },
					},
				},
				required: true,
			},
			responses: { "201": { description: "registered" } },
			security: [],
			"x-entity": { action: "action", name: "note" },
		},
	}
	const respond = overriding(notesApi(notesDoc({ "/register": register }), rows), (method, path) => {
		if (method !== "POST" || path !== "/register") return undefined
		rows.push({ id: "r1", title: "made by a body it never read" })
		return { body: answer, status: 201 }
	})
	const options = optionsFor(respond, { ops: ["notes.register", "notes.get"] })
	const ctx = await contextOf(options)
	trackCreates(ctx)
	await runWriteSecurity(ctx, [anonymousOperationOpen])
	return { ctx, rows, seen: options.seen }
}

describe("trackCreates on an open write a probe sent with no credential", () => {
	it("ledgers what a 2xx made, by the id it names and a read that shows it, and teardown removes it", async () => {
		const { ctx, rows, seen } = await openRegister({ note_id: "r1" })
		expect(ctx.ledger.entries()).toMatchObject([{ entity: "note", id: "r1", owner: { id: "alpha" } }])
		await unwind(ctx)
		expect(seen.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual(["/notes/r1"])
		expect(rows).toEqual([])
	})

	it("reports a 2xx that names no such id as a record that may remain", async () => {
		const { ctx } = await openRegister({ access_token: "t" })
		expect(ctx.ledger.entries()).toEqual([])
		expect(ctx.ledger.unidentifiedCreates).toMatchObject([
			{ entity: "note", operationId: "notes.register", status: 201 },
		])
	})
})

/* Alpha mints project keys with its static bearer token, and the API revokes them. */
const keyed = () =>
	contextOf(optionsFor(keysApi(), { principals: { alpha: { scope: { project_id: "p1" } } }, security: MINTED }))

describe("trackCreates and credentials", () => {
	it("leaves the store's own mint unledgered, and revokes it with the store", async () => {
		const ctx = await keyed()
		trackCreates(ctx)
		expect(await ctx.store.acquire({ principal: "alpha", scheme: "key" })).not.toHaveProperty("blocked")
		expect(ctx.client.transcript.find((exchange) => exchange.operationId === "keys.create")).toMatchObject({
			issuedBy: "credentials",
		})
		expect(ctx.ledger.entries()).toEqual([])
		await revokeCredentials(ctx)
		expect(ctx.client.transcript.at(-1)).toMatchObject({ method: "DELETE", operationId: "keys.revoke", status: 204 })
	})

	it("ledgers and tears down a key a scenario step or raw request creates through the same operation", async () => {
		const ctx = await keyed()
		trackCreates(ctx)
		await ctx.client.request("POST", "/projects/p1/keys", { ...AS_ALPHA, body: { label: "by hand" } })
		expect(ctx.ledger.entries()).toMatchObject([{ id: "1", owner: { id: "alpha" } }])
		await unwind(ctx)
		expect(ctx.state.teardown).toMatchObject({ failed: [], removed: 1 })
	})
})

describe("unwind", () => {
	it("removes what was ledgered, showing its progress every 25 records and at the end", async () => {
		const rows: Record_[] = []
		const snaps: ProgressSnapshot[] = []
		const ctx = await contextWith(rows, { onProgress: (snap) => snaps.push(snap) })
		seed(ctx, rows, 26)
		ctx.progress.check = "c1"
		await unwind(ctx)
		expect(rows).toEqual([])
		expect(ctx.state.teardown).toMatchObject({ failed: [], removed: 26, unsupported: [] })
		const said = snaps.flatMap((snap) => snap.message ?? [])
		/* Newest first: the unwind reverses creation order, so children go before their parents. */
		expect(said.slice(said.indexOf("26 record(s)"))).toEqual(["26 record(s)", "25/26 note n2", "26/26 note n1"])
		expect(snaps.at(-1)).toMatchObject({ phase: "teardown" })
		expect(snaps.at(-1)).not.toHaveProperty("check")
	})

	it("adds a second unwind's report to the first", async () => {
		const rows: Record_[] = []
		const ctx = await contextWith(rows, { teardown: { verify: false } })
		seed(ctx, rows, 1)
		await unwind(ctx)
		rows.push({ id: "m1", title: "m" })
		ctx.principals.recorder(ctx.principals.ownerOf(ctx.principals.alpha))("note", id("m1"), {})
		await unwind(ctx)
		expect(ctx.state.teardown?.removed).toBe(2)
		expect(ctx.state.teardown?.records).toHaveLength(2)
	})
})

describe("unwind edge cases", () => {
	it("leaves everything in place when asked to keep fixtures, or when nothing was made", async () => {
		const rows: Record_[] = []
		const kept = await contextWith(rows, { keepFixtures: true })
		seed(kept, rows, 1)
		await unwind(kept)
		expect(rows).toHaveLength(1)
		const empty = await contextWith([])
		await unwind(empty)
		expect(empty.state.teardown).toBeNull()
	})

	it("reports a verify hook that threw once, however many unwinds it threw in", async () => {
		const rows: Record_[] = []
		const ctx = await contextWith(rows, { hooks: { verifyRemoved } as never })
		seed(ctx, rows, 1)
		await unwind(ctx)
		seed(ctx, rows, 1)
		await unwind(ctx)
		expect(ctx.findings.findings.filter((finding) => finding.check === "teardown.verify-hook")).toEqual([
			expect.objectContaining({ summary: "hooks.verifyRemoved threw" }),
		])
		expect(ctx.state.verifyHookFailed).toBe(true)
	})

	it("reports a teardown that stopped on an unexpected error", async () => {
		const rows: Record_[] = []
		const ctx = await contextWith(rows)
		seed(ctx, rows, 1)
		const broken: RunContext = {
			...ctx,
			principals: { ...ctx.principals, fallbackDeleters: () => [] },
			model: null as never,
		}
		await unwind(broken)
		expect(ctx.findings.findings).toEqual([
			/* Counted after the unwind took the records off the ledger, as it always was. */
			expect.objectContaining({
				check: "world.teardown",
				summary: "teardown stopped on an unexpected error with 0 record(s) ledgered",
			}),
		])
		/* None of what it took is shown gone, so each is a leftover. */
		expect(ctx.state.teardown?.failed).toEqual([
			expect.objectContaining({ reason: expect.stringMatching(/^teardown stopped on an unexpected error: /) }),
		])
		expect(ctx.state.teardown?.records).toEqual([expect.objectContaining({ removed: false })])
	})
})

describe("reportUnremovable", () => {
	it("names the entities whose records no delete reaches", async () => {
		const ctx = await contextWith([])
		reportUnremovable(ctx)
		expect(ctx.findings.findings).toEqual([])
		ctx.state.teardown = { failed: [], records: [], removed: 0, unidentified: [], unsupported: ["note", "tag"] }
		reportUnremovable(ctx)
		expect(ctx.findings.findings).toEqual([expect.objectContaining({ check: "world.teardown", entity: "note, tag" })])
	})
})

describe("revokeCredentials", () => {
	it("revokes what the run minted, and lists each revoke that failed as a record it could not remove", async () => {
		const ctx = await contextOf(
			optionsFor(keysApi(500), { principals: { alpha: { scope: { project_id: "p1" } } }, security: MINTED }),
		)
		await ctx.client.request("GET", "/secure", AS_ALPHA)
		await revokeCredentials(ctx)
		expect(ctx.state.teardown?.failed).toEqual([
			{ entity: "credential", id: "alpha/key", principal: "alpha", reason: "revoke keys.revoke answered 500" },
			{ entity: "credential", id: "alpha/key", principal: "alpha", reason: "revoke keys.revoke answered 500" },
		])
	})

	it("adds nothing when every revoke succeeds, and leaves a secondary origin's to the primary", async () => {
		const options = optionsFor(keysApi(), { principals: { alpha: { scope: { project_id: "p1" } } }, security: MINTED })
		const ctx = await contextOf(options)
		await ctx.client.request("GET", "/secure", AS_ALPHA)
		const shared = { ...ctx, options: { ...ctx.options, sharedCredentials: { mapping: {}, store: ctx.store } } }
		await revokeCredentials(shared)
		expect(options.seen.filter((request) => request.method === "DELETE")).toEqual([])
		await revokeCredentials(ctx)
		expect([ctx.state.teardown, options.seen.filter((request) => request.method === "DELETE")]).toMatchObject([
			null,
			[{}, {}],
		])
	})
})

describe("teardownPrincipals", () => {
	it("removes each principal the run signed up through the hook, with its credential as its scheme places it", async () => {
		const removed: unknown[] = []
		const ctx = await freshRun({
			hooks: { teardownPrincipal: async (address, held) => void removed.push([address, held]) },
		})
		await teardownPrincipals(ctx)
		const email = String(ctx.principals.byId.get("fresh")?.identity.email)
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

	it("names the accounts left behind without a hook, one the hook could not remove, and one it holds nothing for", async () => {
		const bare = await freshRun()
		await teardownPrincipals(bare)
		expect(bare.findings.findings[0]).toMatchObject({
			summary: "1 principal(s) provisioned by this run were not removed",
		})
		const failing = await freshRun({
			hooks: {
				teardownPrincipal: async () => {
					throw new Error("cannot delete")
				},
			},
		})
		await teardownPrincipals(failing)
		expect(failing.findings.findings[0]).toMatchObject({ detail: "cannot delete" })
		expect(failing.findings.findings[0]?.summary).toMatch(/^could not remove provisioned principal \S+@/)
		const keyless = await freshRun({
			hooks: { teardownPrincipal: async () => undefined },
			principals: { alpha: { email: "alpha@x.test" }, fresh: { fresh: true, security: { bearer: { static: "s" } } } },
		})
		await teardownPrincipals(keyless)
		expect(keyless.findings.findings[0]).toMatchObject({
			detail: 'principal "fresh" holds no credential to remove it with',
		})
	})

	it("leaves the accounts to the primary run, and has nothing to do without signed-up accounts", async () => {
		const secondary = await freshRun({ skipPrincipalTeardown: true })
		await teardownPrincipals(secondary)
		const plain = await contextWith([])
		await teardownPrincipals(plain)
		const addressless = await contextOf(
			optionsFor(
				withSignup(() => ({ status: 201 })),
				{ principals: { alpha: { fresh: true } }, security: {} },
			),
		)
		await teardownPrincipals(addressless)
		expect([...secondary.findings.findings, ...plain.findings.findings]).toEqual([])
	})
})

/** The address and credential each hook call was handed, by a run whose principals are `principals`. */
async function removedBy(principals: RunOptions["principals"], respond = withSignup(() => ({ status: 201 }))) {
	const removed: string[] = []
	const ctx = await contextOf(
		optionsFor(respond, {
			hooks: { teardownPrincipal: async (address, held) => void removed.push(`${address} ${held.credential}`) },
			principals,
			security: EMAIL_LOGIN,
		}),
	)
	await teardownPrincipals(ctx)
	return { findings: ctx.findings.findings, removed }
}

describe("teardownPrincipals: only what the run created", () => {
	it("removes a principal whose login registers it by the marked operation, then signs it in", async () => {
		const steps: [AuthStep, ...AuthStep[]] = [
			{ body: { email: "{principal.email}", password: "p4ssw0rd!", tenant: "t1" }, operationId: "auth.signup" },
			{ body: { email: "{principal.email}" }, operationId: "auth.login" },
		]
		const security = { bearer: { login: { from: "$.access_token", steps } } }
		expect(await removedBy({ alpha: { email: "reg@x.test", security } })).toEqual({
			findings: [],
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
		expect(kept).toEqual({ findings: [], removed: [] })
	})

	it("names a created principal it has no address for by its id, rather than calling the hook without one", async () => {
		const bare = await contextOf(
			optionsFor(notesApi(), { principals: { alpha: { created: true } }, security: { bearer: { static: "s" } } }),
		)
		await teardownPrincipals(bare)
		expect(bare.findings.findings[0]?.detail).toMatch(/^oat registered alpha to run this test/)
		const nameless = await removedBy({ alpha: { created: true, security: { bearer: { static: "s" } } } })
		expect(nameless).toEqual({
			findings: [
				expect.objectContaining({
					detail: 'principal "alpha" has no address or email to name it by',
					summary: "could not remove provisioned principal alpha",
				}),
			],
			removed: [],
		})
	})
})

/* Alpha's login, whose sessions `notes.list` revokes, answering `revoked` to that revoke. */
function revocable(extra: Partial<RunOptions> = {}, revoked = 200) {
	const security: SecurityConfig = {
		bearer: { login: { from: "$.token", revoke: "notes.list", steps: [{ operationId: "auth.login" }] } },
	}
	const answer = overriding(withLogin(), (method, path) =>
		method === "GET" && path === "/notes" ? { body: [], status: revoked } : undefined,
	)
	return optionsFor(answer, { security, ...extra })
}

describe("revokeSessions", () => {
	it("ends each configured principal's login session by its declared revoke, as the credential store", async () => {
		const options = revocable()
		const ctx = await contextOf(options)
		await revokeSessions(ctx)
		const revoke = options.seen.filter((request) => request.path === "/notes")
		expect(revoke.map((request) => request.headers.authorization)).toEqual(["Bearer token-1"])
		expect(ctx.client.transcript.at(-1)).toMatchObject({ issuedBy: "credentials", operationId: "notes.list" })
		expect(ctx.state.teardown).toBeNull()
	})

	it("sends nothing when the login declares no revoke, or when the run keeps its credentials", async () => {
		const plain = optionsFor(withLogin(), {
			security: { bearer: { login: { from: "$.token", steps: [{ operationId: "auth.login" }] } } },
		})
		await revokeSessions(await contextOf(plain))
		const kept = revocable({ keepCredentials: true })
		await revokeSessions(await contextOf(kept))
		for (const options of [plain, kept]) expect(options.seen.filter((request) => request.path === "/notes")).toEqual([])
	})

	it("records a revoke that failed as an unremovable credential record", async () => {
		const ctx = await contextOf(revocable({}, 500))
		await revokeSessions(ctx)
		expect(ctx.state.teardown?.failed).toEqual([
			{ entity: "credential", id: "alpha/bearer", principal: "alpha", reason: "revoke notes.list answered 500" },
		])
	})

	it("leaves the session of a principal the run made, which teardownPrincipal already removed", async () => {
		const security: SecurityConfig = {
			bearer: {
				login: {
					from: "$.access_token",
					revoke: "notes.list",
					steps: [{ body: { email: "{principal.email}" }, operationId: "auth.login" }],
				},
			},
		}
		const options = optionsFor(
			withSignup(() => ({ status: 201 })),
			{
				principals: { alpha: { email: "alpha@x.test" }, fresh: { fresh: true } },
				security,
			},
		)
		const ctx = await contextOf(options)
		await ctx.store.acquire({ principal: "fresh", scheme: "bearer" })
		await revokeSessions(ctx)
		const revoke = options.seen.filter((request) => request.method === "GET" && request.path === "/notes")
		expect(revoke.map((request) => request.headers.authorization)).toEqual(["Bearer login-alpha@x.test"])
	})
})
