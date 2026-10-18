import { describe, expect, it } from "vitest"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import type { Exchange } from "../exchange.ts"
import { createdId } from "../proven-id.ts"
import { ALPHA, flow, notesApi, optionsFor, planned, unreachable, withLogin } from "./__fixtures__/api.ts"
import { adoptPrincipals, resolvePrincipals, sameTenant } from "./principals.ts"

/*
 * Who the run acts as: static keys held as configured, flows signed in through the API, and
 * each exchange and record traced back to the principal that sent or made it.
 */

/** An id as a create returns it. */
const id = (value: string) => createdId(value) as NonNullable<ReturnType<typeof createdId>>

describe("resolvePrincipals", () => {
	it("holds a static principal's headers, and keeps its secrets out of every record", async () => {
		const run = await planned(
			optionsFor(notesApi(), {
				principals: [{ ...ALPHA, headers: { "x-api-key": "key-secret-1", accept: "application/json" } }],
			}),
		)
		const [alpha] = (await resolvePrincipals(run)) ?? []
		expect(alpha).toMatchObject({ id: "alpha", inviteAs: undefined, rank: 0, role: undefined, roots: {} })
		expect(alpha?.headers()).toEqual({ accept: "application/json", "x-api-key": "key-secret-1" })
		expect(run.client.redactor.text("key-secret-1 application/json")).toBe("<redacted> application/json")
		expect(run.client.redactor.isSecretHeader("x-api-key")).toBe(true)
		expect(run.client.redactor.isSecretHeader("accept")).toBe(false)
		alpha?.adoptCredential("t2")
		expect(alpha?.headers().authorization).toBe("Bearer t2")
	})

	it("signs a flow principal in, with the roots its flow discovered and its own headers", async () => {
		const run = await planned(optionsFor(withLogin(), { principals: [ALPHA, { ...flow, rank: 2, role: "admin" }] }))
		const [, signed] = (await resolvePrincipals(run)) ?? []
		expect(signed).toMatchObject({ rank: 2, role: "admin", roots: { org_id: "o1", tenant_id: "t1" } })
		expect(signed?.headers()).toEqual({ authorization: "Bearer token-1", "x-client": "oat" })
		expect(signed?.runtime?.address).toBe("a@x.test")
		signed?.adoptCredential("token-9")
		expect(signed?.headers().authorization).toBe("Bearer token-9")
	})
})

describe("resolvePrincipals renewing", () => {
	it("renews a flow principal's credential when the API turns it away, and sends the request again", async () => {
		const state = { failing: false, issued: 0 }
		const login = withLogin(state)
		let refused = false
		const respond: Responder = (method, path, request) => {
			if (path !== "/secure") return login(method, path, request)
			if (!refused) {
				refused = true
				return { status: 401 }
			}
			return { body: { seen: request.headers }, status: 200 }
		}
		const run = await planned(optionsFor(respond, { principals: [flow] }))
		const [signed] = (await resolvePrincipals(run)) ?? []
		const answered = await run.client.get("/secure", { headers: () => signed?.headers() ?? {} })
		expect(answered.status).toBe(200)
		/* Signed in, renewed before sending (it expires inside the buffer), renewed again on the 401. */
		expect(state.issued).toBe(3)
	})

	it("signs a flow principal in with the secondary origins at hand, keeping its configured roots", async () => {
		const origin = { baseUrl: "http://other.test", id: "other", spec: "http://other.test/openapi.json" }
		const { rootsFromFlow: _none, roots: _roots, ...plain } = flow
		const run = await planned(optionsFor(withLogin(), { origins: [origin], principals: [plain] }))
		const [signed] = (await resolvePrincipals(run)) ?? []
		expect(signed?.roots).toEqual({})
		expect(signed?.headers().authorization).toBe("Bearer token-1")
	})
})

describe("resolvePrincipals failing", () => {
	it("is null, with the outage noted, when the network goes away while signing in", async () => {
		const served = optionsFor(withLogin(), { principals: [flow] })
		const down = { now: false }
		const serve = served.network?.fetch as typeof fetch
		const run = await planned({
			...served,
			network: {
				...served.network,
				fetch: (input, init) => (down.now ? unreachable(input, init) : serve(input, init)),
			},
		})
		down.now = true
		expect(await resolvePrincipals(run)).toBeNull()
		expect(run.network.outcome?.kind).toBe("refused")
		expect(run.findings.findings[0]).toMatchObject({ check: "net.unreachable", entity: "auth" })
	})

	it("rethrows a sign-in that fails for any other reason", async () => {
		const state = { failing: true, issued: 0 }
		const run = await planned(optionsFor(withLogin(state), { principals: [flow] }))
		await expect(resolvePrincipals(run)).rejects.toThrow(
			/failed at auth step 1 \(POST \/login\): expected 2xx, got 500/,
		)
	})
})

describe("adoptPrincipals", () => {
	it("names who sent each exchange by the credential it carried", async () => {
		const anonymous = { id: "anon" }
		const run = await planned(optionsFor(notesApi(), { principals: [ALPHA, anonymous] }))
		const authed = adoptPrincipals(run, (await resolvePrincipals(run)) ?? [])
		const sentAs = async (headers: Record<string, string>) => (await authed.client.get("/notes", { headers })).principal
		expect(await sentAs({ authorization: "Bearer alpha-key" })).toBe("alpha")
		expect(await sentAs({ authorization: "Bearer stolen" })).toBeUndefined()
		expect(await sentAs({})).toBe("anon")
		expect(await sentAs({ accept: "application/json" })).toBe("anon")
	})

	it("names nobody for a credential no principal holds, or for none when every principal holds one", async () => {
		const run = await planned(optionsFor(notesApi()))
		const authed = adoptPrincipals(run, (await resolvePrincipals(run)) ?? [])
		const sentAs = async (headers: Record<string, string>) => (await authed.client.get("/notes", { headers })).principal
		expect(await sentAs({ "x-api-key": "someone-elses" })).toBeUndefined()
		expect(await sentAs({})).toBeUndefined()
	})

	it("ledgers what each principal makes as its own, and lets a stronger one of its tenant remove it", async () => {
		const run = await planned(
			optionsFor(notesApi(), {
				principals: [
					{ ...ALPHA, roots: { org_id: "o1" } },
					{ headers: { authorization: "Bearer b" }, id: "admin", rank: 5, roots: { org_id: "o1" } },
					{ headers: { authorization: "Bearer c" }, id: "member", rank: 1, roots: { org_id: "o1" } },
					{ headers: { authorization: "Bearer d" }, id: "stranger", rank: 9, roots: { org_id: "o2" } },
				],
			}),
		)
		const { principals } = adoptPrincipals(run, (await resolvePrincipals(run)) ?? [])
		const owner = principals.ownerOf(principals.alpha)
		expect(principals.fallbackDeleters(owner).map((deleter) => deleter.id)).toEqual(["admin", "member"])
		expect(principals.fallbackDeleters({ headers: () => ({}), id: "nobody" })).toEqual([])
		principals.recorder(owner)("note", id("n1"), {})
		principals.recordCreated({ entity: "note", id: id("n2"), scope: {} }, "member")
		principals.recordCreated({ entity: "note", id: id("n3"), scope: {} }, "ghost")
		principals.recordCreated({ entity: "note", id: id("n4"), scope: {} })
		principals.unidentified("note", "notes.create", { method: "POST", seq: 1, status: 201, url: "u" } as Exchange)
		expect(run.ledger.size).toBe(4)
		expect(run.ledger.unidentifiedCreates).toHaveLength(1)
	})

	it("refreshes stale credentials, and reports one it cannot renew", async () => {
		const state = { failing: false, issued: 0 }
		const run = await planned(optionsFor(withLogin(state), { principals: [ALPHA, flow] }))
		const { principals } = adoptPrincipals(run, (await resolvePrincipals(run)) ?? [])
		expect(await principals.refreshAll("note")).toBe(true)
		state.failing = true
		expect(await principals.refreshAll("note")).toBe(false)
		expect(run.findings.findings).toEqual([
			expect.objectContaining({
				check: "auth.refresh",
				entity: "note",
				summary: 'refreshing the credential of "flow" failed',
			}),
		])
	})
})

describe("sameTenant", () => {
	it("is the same tenant when every root either names agrees", () => {
		expect(sameTenant({}, {})).toBe(true)
		expect(sameTenant({ org: "1" }, { org: "1" })).toBe(true)
		expect(sameTenant({ org: "1" }, { org: "2" })).toBe(false)
		expect(sameTenant({ org: "1" }, {})).toBe(false)
	})
})
