import { describe, expect, it } from "vitest"
import type { DedicatedCredential, Replayed } from "../../core/operation-context.ts"
import { modelOf, type Sent } from "../../__fixtures__/harness.ts"
import { actorOf, operationContextFor, sender } from "./__fixtures__/operation-context.ts"
import { securedDoc } from "./__fixtures__/secured-api.ts"
import { refreshReuseRefused } from "./auth-refresh-reuse-refused.ts"

/* A dedicated session is rotated once; replaying the refresh token it rotated away must fail. */

const model = modelOf(securedDoc())
const alpha = actorOf("alpha", { scope: { project_id: "proj_a" }, tenant: "proj_a" })
const JWT = { issue: "auth.login", kind: "login", refresh: "auth.refresh" } as const

interface Backend {
	replay?: Replayed
	/** What the rotated session draws on the read. */
	rotated?: number
	rotates?: boolean
}

function staged(operationId: string, backend: Backend) {
	const events: string[] = []
	const dedicated = (): DedicatedCredential => ({
		actor: { principal: "alpha#probe-1" },
		owner: "alpha",
		scheme: "jwt",
		value: "first",
		...(backend.rotates === false
			? {}
			: {
					rotate: async () => {
						events.push("rotate")
						return {
							replay: async () => {
								events.push("replay")
								return backend.replay ?? { accepted: false, reason: "refresh answered 401" }
							},
							value: "second",
						}
					},
				}),
	})
	const respond = (sent: Sent) => {
		events.push(`GET ${sent.path}`)
		return sender(sent) === "alpha#probe-1" ? { status: backend.rotated ?? 200 } : undefined
	}
	const stage = operationContextFor(model, operationId, {
		principals: [alpha],
		probe: { dedicated, recipes: { jwt: JWT } },
		respond,
	})
	return { ...stage, events }
}

async function run(stage: ReturnType<typeof staged>) {
	const planned = refreshReuseRefused.plan(stage.ctx)
	if (!planned.ok) throw new Error(planned.needs)
	return refreshReuseRefused.run(stage.ctx, planned.value)
}

describe("auth.refresh-reuse-refused", () => {
	it("passes when the reused refresh token is refused, after proving the rotated session on one read", async () => {
		const stage = staged("auth.refresh", {})
		expect(await run(stage)).toEqual({ kind: "asserted" })
		expect(stage.events).toEqual(["rotate", "GET /projects/proj_a/notes", "replay"])
		expect(stage.calls.dedicated).toEqual([{ principal: "alpha", scheme: "jwt", scopes: [] }])
		expect(stage.sent[0]?.options.as).toEqual({ principal: "alpha#probe-1", scheme: "jwt" })
		expect([refreshReuseRefused.mutates, refreshReuseRefused.mutatesCredentials]).toEqual([true, true])
	})

	it("reports a security finding when the rotated-away refresh token refreshes again", async () => {
		const stage = staged("auth.refresh", { replay: { accepted: true } })
		expect(await run(stage)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.findings.findings).toMatchObject([
			{
				check: "auth.refresh-reuse-refused",
				detail: expect.stringMatching(/alpha's jwt session.*auth\.refresh.*proven on notes\.list/),
				summary: "a rotated jwt refresh token refreshes again",
			},
		])
	})

	it("is unresolved when the rotated session is refused on the read", async () => {
		const stage = staged("auth.refresh", { rotated: 401 })
		expect(await run(stage)).toEqual({
			kind: "unresolved",
			reason: "the rotated jwt session was refused (401) on notes.list, so a refused reuse would prove nothing",
		})
		expect(stage.events).not.toContain("replay")
	})

	it("is untested without a dedicated session that rotates, and plans only on the refresh operation", async () => {
		expect(await run(staged("auth.refresh", { rotates: false }))).toEqual({
			kind: "stood-down",
			reason: "jwt: the dedicated credential has no declared refresh",
		})
		const none = operationContextFor(model, "auth.refresh", { principals: [alpha], probe: { recipes: { jwt: JWT } } })
		const planned = refreshReuseRefused.plan(none.ctx)
		if (!planned.ok) throw new Error("expected a plan")
		expect(await refreshReuseRefused.run(none.ctx, planned.value)).toEqual({
			kind: "stood-down",
			reason: "jwt: no dedicated credential in this test",
		})
		expect(refreshReuseRefused.plan(staged("notes.list", {}).ctx)).toEqual({
			needs: "the refresh operation of a recipe; this check runs on auth.refresh",
			ok: false,
		})
	})
})

/* A record beta created in its own project: the probe's target, whose creator expects acceptance. */
const beta = actorOf("beta", { scope: { project_id: "proj_b" }, tenant: "proj_b" })
const BETA_TARGET = {
	current: { id: "n1" },
	entity: "note",
	id: "n1",
	owner: "beta",
	params: { note_id: "n1", project_id: "proj_b" },
	path: "/projects/proj_b/notes/n1",
}

/* Beta's dedicated session, which rotates once and refuses its replay. */
const betaSession = (): DedicatedCredential => ({
	actor: { principal: "beta#probe-1" },
	owner: "beta",
	rotate: async () => ({ replay: async () => ({ accepted: false, reason: "401" }), value: "second" }),
	scheme: "jwt",
	value: "first",
})

describe("auth.refresh-reuse-refused on a record another principal created", () => {
	it("acts as the record's creator: its own dedicated session, proven in its own scope", async () => {
		const stage = operationContextFor(model, "auth.refresh", {
			principals: [alpha, beta],
			probe: { dedicated: betaSession, recipes: { jwt: JWT } },
			respond: () => ({ status: 200 }),
			target: BETA_TARGET,
		})
		const planned = refreshReuseRefused.plan(stage.ctx)
		if (!planned.ok) throw new Error(planned.needs)
		expect(await refreshReuseRefused.run(stage.ctx, planned.value)).toEqual({ kind: "asserted" })
		expect(stage.calls.dedicated).toEqual([{ principal: "beta", scheme: "jwt", scopes: [] }])
		expect(stage.sent.map((s) => [s.path, sender(s)])).toEqual([["/projects/proj_b/notes", "beta#probe-1"]])
	})
})
