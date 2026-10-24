import { describe, expect, it } from "vitest"
import type { Recipe } from "../../config/types/security.ts"
import type { Responder } from "../checks/__fixtures__/harness.ts"
import {
	bearerOnly,
	contextOf,
	LOGIN,
	notesApi,
	notesDoc,
	optionsFor,
	signupDoc,
	unreachable,
	withLogin,
} from "./__fixtures__/api.ts"
import { keysApi, keysDoc, MINTED } from "./__fixtures__/keys.ts"
import { closeOut, run } from "./pipeline.ts"
import { scopeReport } from "./result.ts"
import { run as libraryRun } from "../../index.ts"

/* The email login, whose session the login operation itself ends when sent with it. */
const REVOCABLE_EMAIL: Recipe = {
	login: {
		from: "$.access_token",
		revoke: "auth.login",
		steps: [{ body: { email: "{principal.email}" }, operationId: "auth.login" }],
	},
}

const ORIGIN = { baseUrl: "http://other.test", id: "other", spec: "http://other.test/openapi.json" }

/*
 * The whole run, stage after stage, against a correct in-memory notes API: what it seeds it
 * removes, what it tests it reports, and the stages run in order.
 */

describe("run and the writer", () => {
	it("acts as the writer the options name, not the first principal, for a library caller too", async () => {
		const options = optionsFor(bearerOnly(notesApi(notesDoc()), "beta-key"), {
			principals: { alpha: {}, beta: { security: { bearer: { static: "beta-key" } } } },
			writer: "beta",
		})
		const result = await libraryRun(options)
		expect(result.entitiesTested).toEqual(["note"])
		const creates = options.seen.filter((request) => request.method === "POST")
		expect(creates.length).toBeGreaterThan(0)
		expect(creates.every((request) => request.headers["authorization"] === "Bearer beta-key")).toBe(true)
	})
})

describe("run", () => {
	it("tests a correct API end to end, removing everything it created", async () => {
		const rows: Array<Record<string, unknown>> = []
		const phases: string[] = []
		const options = optionsFor(notesApi(notesDoc(), rows), {
			onProgress: (snap) => {
				if (phases.at(-1) !== snap.phase) phases.push(snap.phase)
			},
		})
		const result = await run(options)
		expect(result.entitiesTested).toEqual(["note"])
		expect(result.checksRun.length).toBeGreaterThan(10)
		expect(result.created).toBeGreaterThan(0)
		expect(result.teardown?.removed).toBe(result.created)
		expect(rows).toEqual([])
		expect(phases).toEqual([
			"load",
			"auth",
			"seed",
			"test",
			"teardown",
			"scenario",
			"test",
			"contract",
			"teardown",
			"done",
		])
		expect(options.seen[0]).toMatchObject({ method: "GET", path: "/openapi.json" })
		expect(result.principals).toEqual([expect.objectContaining({ id: "alpha" })])
		expect(result.findings.filter((finding) => finding.verdict === "BACKEND_BUG")).toEqual([])
	})

	it("returns at once, with the outage, when the network goes away while signing in", async () => {
		const served = optionsFor(withLogin(), { security: LOGIN })
		const serve = served.network?.fetch as typeof fetch
		const offAfterLoad: typeof fetch = (input, init) =>
			String(input).endsWith("/openapi.json") ? serve(input, init) : unreachable(input, init)
		const result = await run({ ...served, network: { ...served.network, fetch: offAfterLoad } })
		expect(result).toMatchObject({ entitiesTested: [], principals: [], teardown: null })
		expect(result.network?.kind).toBe("refused")
	})
})

describe("run with secondary origins", () => {
	it("runs each secondary origin, and reports one that stops on an unexpected error", async () => {
		const origin = {
			baseUrl: "http://other.test",
			id: "other",
			security: { bearer: "bearer" },
			spec: "http://other.test/openapi.json",
		}
		const broken = { covers: [], id: "broken", origin: "other", steps: [{ operationId: "no.such" }] }
		const result = await run(optionsFor(notesApi(), { origins: [origin], scenarios: [broken] as never }))
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				check: "run.error",
				entity: "origins",
				summary: "the secondary origins stopped on an unexpected error",
			}),
		)
	})

	it("leaves secondary origins and provisioned accounts to the primary run", async () => {
		const origin = {
			baseUrl: "http://other.test",
			id: "other",
			security: { bearer: "bearer" },
			spec: "http://other.test/openapi.json",
		}
		const options = optionsFor(notesApi(), { origins: [origin], skipPrincipalTeardown: true })
		const result = await run(options)
		/* Its document is read to plan the run; nothing else is sent to it. */
		expect(options.seen.filter((request) => request.host === "other.test").map((request) => request.path)).toEqual([
			"/openapi.json",
		])
		expect(result.entitiesTested).toEqual(["note"])
	})
})

describe("closeOut", () => {
	it("runs the origins, revokes what was minted, removes the accounts the run signed up, then ends the sessions", async () => {
		const events: string[] = []
		const doc = keysDoc() as unknown as { paths: Record<string, unknown> }
		const { "/login": login, "/signup": signup } = signupDoc.paths as Record<string, unknown>
		Object.assign(doc.paths, { "/login": login, "/signup": signup })
		const keys = keysApi()
		const respond: Responder = (method, path, request) => {
			if (path === "/openapi.json") return { body: doc, status: 200 }
			if (path === "/signup") return { status: 201 }
			if (path === "/login" && request.headers?.["authorization" as never] !== undefined)
				events.push("revoke alpha's session")
			/* Each principal's own session: one shared would be no account's own to remove it with. */
			const email = String((request.body as { email?: unknown } | undefined)?.email)
			if (path === "/login") return { body: { access_token: `session-${email}` }, status: 200 }
			if (method === "DELETE") events.push(`revoke ${path}`)
			return keys(method, path, request)
		}
		const ctx = await contextOf(
			optionsFor(respond, {
				hooks: { teardownPrincipal: async (address) => void events.push(`teardown ${address}`) },
				origins: [{ ...ORIGIN, security: { bearer: "bearer", key: "key" } }],
				principals: {
					alpha: { email: "a@x.test", scope: { project_id: "p1" } },
					fresh: { fresh: true, scope: { project_id: "p1" } },
				},
				security: { bearer: REVOCABLE_EMAIL, key: MINTED["key"] as Recipe },
			}),
		)
		await ctx.client.request("GET", "/secure", { as: { principal: "fresh" } })
		const runOrigin = async (): Promise<never> => {
			events.push("origin")
			throw new Error("origin done")
		}
		await closeOut(ctx, { coverage: scopeReport(ctx), runOrigin })
		const email = String(ctx.principals.byId.get("fresh")?.identity["email"])
		expect(events).toEqual([
			"origin",
			"revoke /projects/p1/keys/1",
			"revoke /projects/p1/keys/2",
			`teardown ${email}`,
			"revoke alpha's session",
		])
	})
})
