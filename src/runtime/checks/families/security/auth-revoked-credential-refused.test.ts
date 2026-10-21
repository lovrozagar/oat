import { describe, expect, it } from "vitest"
import type { DedicatedCredential } from "../../core/operation-context.ts"
import { modelOf, type Sent } from "../../__fixtures__/harness.ts"
import { actorOf, operationContextFor, sender } from "./__fixtures__/operation-context.ts"
import { securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { revokedCredentialRefused } from "./auth-revoked-credential-refused.ts"

/* A dedicated credential, revoked through its recipe's declared path, must be refused afterwards. */

const model = modelOf(securedDoc())
const alpha = actorOf("alpha", { scope: { project_id: "proj_a" }, tenant: "proj_a" })
const JWT = { issue: "auth.login", kind: "login", revoke: "auth.revoke" } as const

interface Backend {
	/** The status a request with the probe credential draws before and after its revoke. */
	before?: number
	after: number
	/** Whether the dedicated credential declares a revoke. */
	revocable?: boolean
}

function staged(operationId: string, backend: Backend) {
	let revoked = false
	const dedicated = (): DedicatedCredential => ({
		actor: { principal: "alpha#probe-1" },
		owner: "alpha",
		scheme: "jwt",
		value: "probe-token",
		...(backend.revocable === false ? {} : { revoke: async () => void (revoked = true) }),
	})
	const respond = (sent: Sent) =>
		sender(sent) === "alpha#probe-1" ? { status: revoked ? backend.after : (backend.before ?? 200) } : undefined
	return operationContextFor(model, operationId, {
		principals: [alpha],
		probe: { dedicated, recipes: { jwt: JWT } },
		respond,
	})
}

async function run(stage: ReturnType<typeof staged>) {
	const planned = revokedCredentialRefused.plan(stage.ctx)
	if (!planned.ok) throw new Error(planned.needs)
	return revokedCredentialRefused.run(stage.ctx, planned.value)
}

describe("auth.revoked-credential-refused", () => {
	it("passes when the revoked credential is refused on the first qualifying read", async () => {
		const stage = staged("auth.revoke", { after: 401 })
		expect(await run(stage)).toEqual({ kind: "asserted" })
		expect(stage.calls.dedicated).toEqual([{ principal: "alpha", scheme: "jwt", scopes: [] }])
		expect(stage.sent.map((s) => [s.method, s.path, s.options.operationId, s.options.probe])).toEqual([
			["GET", "/projects/proj_a/feed", "feed.list", undefined],
			["GET", "/projects/proj_a/feed", "feed.list", true],
		])
		expect(stage.sent.map((s) => s.options.as)).toEqual([
			{ principal: "alpha#probe-1", scheme: "jwt" },
			{ principal: "alpha#probe-1", scheme: "jwt" },
		])
		expect([revokedCredentialRefused.mutates, revokedCredentialRefused.mutatesCredentials]).toEqual([true, true])
	})

	it("reports a security finding when the revoked credential still authenticates", async () => {
		const stage = staged("auth.revoke", { after: 200 })
		expect(await run(stage)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.findings.findings).toMatchObject([
			{
				check: "auth.revoked-credential-refused",
				detail: expect.stringMatching(/alpha's jwt credential.*auth\.revoke.*feed\.list answered 200/),
				summary: "a revoked jwt credential still authenticates",
			},
		])
		expect(stage.findings.findings[0]?.evidence).toHaveLength(2)
	})

	it("is unresolved when the fresh credential is refused before its revoke, or the after answer is no refusal", async () => {
		const early = staged("auth.revoke", { after: 401, before: 401 })
		expect(await run(early)).toEqual({
			kind: "unresolved",
			reason: "a fresh jwt credential was refused (401) on feed.list before its revoke",
		})
		expect(early.sent).toHaveLength(1)
		const odd = staged("auth.revoke", { after: 500 })
		expect(await run(odd)).toEqual({
			kind: "unresolved",
			reason: "after its revoke, a jwt credential drew 500 on feed.list, neither a refusal nor a success",
		})
	})
})

describe("auth.revoked-credential-refused (2)", () => {
	it("is untested when no dedicated credential can be had, or it has no revoke", async () => {
		const none = operationContextFor(model, "auth.revoke", { principals: [alpha], probe: { recipes: { jwt: JWT } } })
		const planned = revokedCredentialRefused.plan(none.ctx)
		if (!planned.ok) throw new Error("expected a plan")
		expect(await revokedCredentialRefused.run(none.ctx, planned.value)).toEqual({
			kind: "stood-down",
			reason: "jwt: no dedicated credential in this test",
		})
		expect(await run(staged("auth.revoke", { after: 401, revocable: false }))).toEqual({
			kind: "stood-down",
			reason: "jwt: the dedicated credential has no declared revoke",
		})
	})

	it("plans only on the recipe's revoke operation, and stands down without declared security", () => {
		expect(revokedCredentialRefused.plan(staged("notes.list", { after: 401 }).ctx)).toEqual({
			needs: "the revoke operation of a recipe; this check runs on auth.revoke",
			ok: false,
		})
		const open = operationContextFor(modelOf(undeclaredDoc()), "auth.revoke", { principals: [alpha] })
		expect(revokedCredentialRefused.plan(open.ctx).ok).toBe(false)
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

/* Beta's dedicated credential, which declares a revoke. */
const betaCredential = (): DedicatedCredential => ({
	actor: { principal: "beta#probe-1" },
	owner: "beta",
	revoke: async () => undefined,
	scheme: "jwt",
	value: "probe-token",
})

describe("auth.revoked-credential-refused on a record another principal created", () => {
	it("acts as the record's creator: its own dedicated credential, proven and revoked in its own scope", async () => {
		const stage = operationContextFor(model, "auth.revoke", {
			principals: [alpha, beta],
			probe: { dedicated: betaCredential, recipes: { jwt: JWT } },
			respond: (sent) => ({ status: sent.options.probe === true ? 401 : 200 }),
			target: BETA_TARGET,
		})
		expect(await run(stage)).toEqual({ kind: "asserted" })
		expect(stage.calls.dedicated).toEqual([{ principal: "beta", scheme: "jwt", scopes: [] }])
		expect(stage.sent.map((s) => [s.path, sender(s)])).toEqual([
			["/projects/proj_b/feed", "beta#probe-1"],
			["/projects/proj_b/feed", "beta#probe-1"],
		])
	})
})
