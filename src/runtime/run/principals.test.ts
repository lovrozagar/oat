import { describe, expect, it } from "vitest"
import type { SecurityConfig } from "../../config/types/security.ts"
import { jwtOf } from "../../credentials/__fixtures__/jwt.ts"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import type { Exchange } from "../exchange.ts"
import { createdId } from "../proven-id.ts"
import {
	EMAIL_LOGIN,
	LOGIN,
	loginDoc,
	notesApi,
	optionsFor,
	planned,
	unreachable,
	withLogin,
	withSignup,
} from "./__fixtures__/api.ts"
import type { RunPrincipals } from "./context.ts"
import { createdByRun, resolvePrincipals } from "./principals.ts"

/*
 * Who the run acts as: every login run before anything is planned, so what its claims bind is what
 * isolation is planned from; a principal that cannot sign in BLOCKED and left out; and each record
 * traced to the principal that made it.
 */

/** An id as a create returns it. */
const id = (value: string) => createdId(value) as NonNullable<ReturnType<typeof createdId>>

/** A login that issues a JWT naming the tenant and project of the key it is sent; `refused` keys answer 401. */
function claimsLogin(refused: ReadonlySet<string> = new Set()): Responder {
	const notes = notesApi(loginDoc)
	return (method, path, request) => {
		if (path !== "/login") return notes(method, path, request)
		const key = String((request.body as { key?: unknown } | undefined)?.key)
		if (refused.has(key)) return { body: { error: "bad key" }, status: 401 }
		return { body: { token: jwtOf({ org_id: `org-${key}`, project: `p-${key}` }) }, status: 200 }
	}
}

const CLAIMED: SecurityConfig = {
	bearer: {
		login: {
			claims: { "scope.project_id": "project", tenant: "org_id" },
			from: "$.token",
			steps: [{ body: { key: "{principal.key}" }, operationId: "auth.login" }],
		},
	},
}

async function signedIn(respond: Responder, extra: Parameters<typeof optionsFor>[1]): Promise<RunPrincipals> {
	const principals = await resolvePrincipals(await planned(optionsFor(respond, extra)))
	if (principals === null) throw new Error("nobody signed in")
	return principals
}

describe("resolvePrincipals", () => {
	it("binds the tenant and scope a login's claims carry before planning, so isolation is planned across them", async () => {
		const principals = await signedIn(claimsLogin(), {
			principals: { alpha: { key: "a", rank: 2 }, beta: { inviteAs: "b@x.test", key: "b" }, gamma: { key: "a" } },
			security: CLAIMED,
		})
		const { alpha, all, byId } = principals
		expect(alpha).toEqual({
			fresh: false,
			id: "alpha",
			identity: { key: "a" },
			rank: 2,
			scope: { project_id: "p-a" },
			tenant: "org-a",
		})
		expect(byId.get("beta")).toMatchObject({ inviteAs: "b@x.test", rank: 0, tenant: "org-b" })
		expect(principals.peerOf(alpha)?.id).toBe("beta")
		expect(principals.peerOf(byId.get("beta") as typeof alpha)?.id).toBe("alpha")
		expect([principals.sameTenant(alpha, all[2] as typeof alpha), principals.blocked]).toEqual([true, []])
	})

	it("holds the config's tenant and scope for a principal no login binds, and has no peer within one tenant", async () => {
		const principals = await signedIn(notesApi(), {
			principals: { alpha: { scope: { org_id: "o1" }, tenant: "t1" }, beta: { tenant: "t1" } },
		})
		expect(principals.alpha).toMatchObject({ scope: { org_id: "o1" }, tenant: "t1" })
		expect(principals.alpha).not.toHaveProperty("readOnly")
		expect(principals.peerOf(principals.alpha)).toBeUndefined()
	})

	it("carries a principal the config marks read-only, which never becomes identity data", async () => {
		const principals = await signedIn(notesApi(), {
			principals: { alpha: { tenant: "t1" }, viewer: { readOnly: true, tenant: "t1" } },
		})
		expect(principals.byId.get("viewer")).toMatchObject({ identity: {}, readOnly: true })
	})

	it("leaves a mint or a static credential to the first request that needs it", async () => {
		const run = await planned(optionsFor(notesApi()))
		await resolvePrincipals(run)
		expect(run.client.transcript).toEqual([])
	})
})

describe("resolvePrincipals, when a login fails", () => {
	it("reports a principal whose login fails as BLOCKED, once, and goes on without it", async () => {
		const run = await planned(
			optionsFor(claimsLogin(new Set(["b"])), {
				principals: { alpha: { key: "a" }, beta: { key: "b" } },
				security: CLAIMED,
			}),
		)
		const principals = (await resolvePrincipals(run)) as RunPrincipals
		expect(principals.all.map((principal) => principal.id)).toEqual(["alpha"])
		const reason =
			'login for beta/bearer: oat: principal "beta" failed at auth step 1 ' +
			'(POST /login): expected 2xx, got 401 — {"error":"bad key"}'
		expect(principals.blocked).toEqual([{ id: "beta", reason }])
		expect(run.findings.findings).toEqual([
			expect.objectContaining({
				check: "auth.blocked",
				detail: `blocked by ${reason}`,
				entity: "beta",
				summary: 'principal "beta" is BLOCKED',
				verdict: "BLOCKED",
			}),
		])
		expect(run.client.transcript.filter((exchange) => exchange.url.endsWith("/login"))).toHaveLength(2)
	})

	it("has nobody to act as when no principal can sign in", async () => {
		const run = await planned(optionsFor(withLogin({ failing: true, issued: 0 }), { security: LOGIN }))
		expect(await resolvePrincipals(run)).toBeNull()
		expect(run.findings.findings.map((finding) => finding.check)).toEqual(["auth.blocked"])
	})
})

describe("resolvePrincipals when the network goes away", () => {
	it("is null, with the outage noted, when a login never gets an answer", async () => {
		const served = optionsFor(withLogin(), { security: LOGIN })
		const serve = served.network?.fetch as typeof fetch
		const run = await planned({
			...served,
			network: {
				...served.network,
				fetch: (input, init) => (String(input).endsWith("/login") ? unreachable(input, init) : serve(input, init)),
			},
		})
		expect(await resolvePrincipals(run)).toBeNull()
		expect(run.network.outcome?.kind).toBe("refused")
		expect(run.findings.findings[0]).toMatchObject({ check: "net.unreachable", entity: "auth" })
	})

	it("is null, with the outage noted, when a fresh principal's signup never gets an answer", async () => {
		const signup = {
			"/signup": {
				post: {
					operationId: "auth.signup",
					responses: { "201": { description: "made" } },
					security: [],
					"x-fresh-principal": true,
				},
			},
		}
		const doc = { ...loginDoc, paths: { ...loginDoc.paths, ...signup } }
		const served = optionsFor(notesApi(doc), { principals: { alpha: { fresh: true } } })
		const serve = served.network?.fetch as typeof fetch
		const run = await planned({
			...served,
			network: {
				...served.network,
				fetch: (input, init) => (String(input).endsWith("/signup") ? unreachable(input, init) : serve(input, init)),
			},
		})
		expect(await resolvePrincipals(run)).toBeNull()
		expect(run.network.outcome?.kind).toBe("refused")
	})

	it("rethrows anything else that stops a signup", async () => {
		const run = await planned(
			optionsFor(
				withSignup(() => ({ status: 201 })),
				{
					principals: { alpha: { email: "a@x.test" }, fresh: { fresh: true } },
					security: EMAIL_LOGIN,
				},
			),
		)
		const failing = { ...run, client: { view: () => ({ request: () => Promise.reject(new Error("boom")) }) } } as never
		await expect(resolvePrincipals(failing)).rejects.toThrow("boom")
	})
})

describe("resolvePrincipals: fresh principals", () => {
	it("signs a fresh principal up, then signs it in by its recipe as the identity it signed up with", async () => {
		const principals = await signedIn(
			withSignup(() => ({ status: 201 })),
			{ principals: { alpha: { fresh: true, rank: 1 } }, security: EMAIL_LOGIN },
		)
		const { alpha } = principals
		expect([alpha.fresh, alpha.rank, typeof alpha.identity["email"], alpha.tenant]).toEqual([
			true,
			1,
			"string",
			undefined,
		])
	})

	it("signs in a principal of an API whose config names no recipe at all", async () => {
		const { security: _none, ...bare } = optionsFor(notesApi())
		const principals = await resolvePrincipals(await planned(bare))
		expect(principals?.alpha.id).toBe("alpha")
	})

	it("reports a fresh principal whose signup is refused as BLOCKED by its signup, and goes on without it", async () => {
		const run = await planned(
			optionsFor(
				withSignup(() => ({ status: 409 })),
				{
					principals: { alpha: { email: "a@x.test" }, fresh: { fresh: true } },
					security: EMAIL_LOGIN,
				},
			),
		)
		const principals = (await resolvePrincipals(run)) as RunPrincipals
		const reason = "signup for fresh by auth.signup: answered 409"
		expect([principals.all.map((principal) => principal.id), principals.blocked]).toEqual([
			["alpha"],
			[{ id: "fresh", reason }],
		])
		expect(run.findings.findings[0]).toMatchObject({
			check: "auth.blocked",
			detail: `blocked by ${reason}`,
			entity: "fresh",
		})
	})

	it("is refused before anything is sent when the document marks no signup for a fresh principal", async () => {
		await expect(
			planned(optionsFor(notesApi(), { principals: { alpha: {}, fresh: { fresh: true } } })),
		).rejects.toThrow("principals.fresh is fresh, but the document marks no x-fresh-principal operation to sign it up")
	})
})

describe("RunPrincipals: the ledger", () => {
	it("ledgers what each principal makes as its own, and lets a stronger one of its tenant remove it", async () => {
		const run = await planned(
			optionsFor(notesApi(), {
				principals: {
					admin: { rank: 5, tenant: "o1" },
					alpha: { tenant: "o1" },
					member: { rank: 1, tenant: "o1" },
					stranger: { rank: 9, tenant: "o2" },
				},
			}),
		)
		const principals = (await resolvePrincipals(run)) as RunPrincipals
		const owner = principals.ownerOf(principals.byId.get("alpha") as RunPrincipals["alpha"])
		expect(owner).toEqual({ id: "alpha" })
		expect(principals.fallbackDeleters(owner).map((deleter) => deleter.id)).toEqual(["admin", "member"])
		expect(principals.fallbackDeleters({ id: "nobody" })).toEqual([])
		principals.recorder(owner)("note", id("n1"), {})
		principals.recordCreated({ entity: "note", id: id("n2"), scope: {} }, "member")
		principals.recordCreated({ entity: "note", id: id("n3"), scope: {} }, "ghost")
		principals.recordCreated({ entity: "note", id: id("n4"), scope: {} })
		principals.unidentified("note", "notes.create", { method: "POST", seq: 1, status: 201, url: "u" } as Exchange)
		expect(run.ledger.size).toBe(4)
		expect(run.ledger.unidentifiedCreates).toHaveLength(1)
	})
})

const signup = { body: { email: "{principal.email}", password: "p4ssw0rd!", tenant: "t1" } }
const thenLogIn = { body: { email: "{principal.email}" }, operationId: "auth.login" }
/** A login recipe whose steps start with `first`, then sign in by email. */
const registering = (first: object): SecurityConfig => ({
	bearer: { login: { from: "$.access_token", steps: [first as never, thenLogIn] } },
})

describe("createdByRun", () => {
	it("is every principal the run made: fresh, registered by the marked operation, or declared created", async () => {
		const run = await planned(
			optionsFor(
				withSignup(() => ({ status: 201 })),
				{
					principals: {
						declared: { created: true, email: "d@x.test" },
						fresh: { fresh: true },
						plain: { email: "p@x.test" },
						raw: { email: "r@x.test", security: registering({ method: "post", path: "/signup", ...signup }) },
						registered: { email: "g@x.test", security: registering({ operationId: "auth.signup", ...signup }) },
					},
					security: EMAIL_LOGIN,
				},
			),
		)
		const made = Object.keys(run.store.principals).filter((principal) => createdByRun(run, principal))
		expect(made).toEqual(["declared", "fresh", "raw", "registered"])
	})

	it("is never a configured account whose login binds or answers an address", async () => {
		const binding: SecurityConfig = {
			bearer: {
				login: { from: "$.token", steps: [{ bind: { address: "{principal.email}" }, operationId: "auth.login" }] },
			},
		}
		const elsewhere = { method: "POST", origin: "app", path: "/signup", ...signup }
		const run = await planned(
			optionsFor(
				withSignup(() => ({ status: 201 })),
				{
					principals: {
						alpha: { email: "a@x.test" },
						beta: { email: "b@x.test", security: registering({ method: "GET", path: "/signup" }) },
						delta: {
							email: "d@x.test",
							security: registering({ outOfBand: { address: "d@x.test", as: "code", kind: "otp" } }),
						},
						gamma: { email: "c@x.test", security: registering(elsewhere) },
						minted: { security: { bearer: { static: "s" } } },
					},
					security: binding,
				},
			),
		)
		expect(Object.keys(run.store.principals).filter((principal) => createdByRun(run, principal))).toEqual([])
	})

	it("is not a principal whose own login names an operation other than the signup", async () => {
		const { security: _shared, ...options } = optionsFor(
			withSignup(() => ({ status: 201 })),
			{
				principals: { alpha: { email: "a@x.test", security: registering({ operationId: "auth.login" }) } },
			},
		)
		expect(createdByRun(await planned(options), "alpha")).toBe(false)
	})
})

describe("createdByRun without a signup", () => {
	it("is no configured account when the document marks no signup at all", async () => {
		const run = await planned(optionsFor(withLogin(), { security: LOGIN }))
		expect(createdByRun(run, "alpha")).toBe(false)
	})
})
