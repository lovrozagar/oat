import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import { modelOf, type Sent } from "../../__fixtures__/harness.ts"
import { actorOf, operationContextFor, sender } from "./__fixtures__/operation-context.ts"
import { securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { crossTenantKeyRefused } from "./auth-cross-tenant-key-refused.ts"
import { BY_VALIDATION } from "./probing.ts"

/* The peer tenant's API key, sent to a route under the actor's tenant, must be refused. */

const model = modelOf(securedDoc())
const alpha = actorOf("alpha", { scope: { project_id: "proj_a" }, tenant: "proj_a" })
const beta = actorOf("beta", { scope: { project_id: "proj_b" }, tenant: "proj_b" })

/* The backend: beta's key under proj_a draws `cross`; under its own proj_b, `own`. */
function staged(operationId: string, statuses: { cross: number; own?: number }, peer: typeof beta | null = beta) {
	const respond = (sent: Sent) => {
		if (sender(sent) !== "beta") return undefined
		return { status: sent.path.includes("proj_a") ? statuses.cross : (statuses.own ?? 200) }
	}
	return operationContextFor(model, operationId, {
		principals: peer === null ? [alpha] : [alpha, peer],
		respond,
		...(peer === null ? {} : { peer }),
	})
}

async function run(stage: ReturnType<typeof staged>) {
	const planned = crossTenantKeyRefused.plan(stage.ctx)
	if (!planned.ok) throw new Error(planned.needs)
	return crossTenantKeyRefused.run(stage.ctx, planned.value)
}

describe("auth.cross-tenant-key-refused", () => {
	it("passes when the peer's key is refused in the actor's tenant and accepted in its own", async () => {
		for (const cross of [401, 403, 404]) {
			const stage = staged("notes.list", { cross })
			expect(await run(stage)).toEqual({ kind: "asserted" })
			expect(stage.sent.map((s) => [s.path, s.options.as, s.options.probe])).toEqual([
				["/projects/proj_a/notes", { principal: "beta", scheme: "apiKey" }, true],
				["/projects/proj_b/notes", { principal: "beta", scheme: "apiKey" }, undefined],
			])
		}
		expect(crossTenantKeyRefused.mutates).toBeUndefined()
	})

	it("reports a security finding when the peer's key reads the actor's tenant", async () => {
		const stage = staged("notes.list", { cross: 200 })
		expect(await run(stage)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.findings.findings).toMatchObject([
			{
				check: "auth.cross-tenant-key-refused",
				detail: expect.stringMatching(/beta's apiKey key \(tenant proj_b\).*proj_a.*notes\.list answered 200/),
				summary: "an apiKey key of one tenant is accepted in another",
			},
		])
		expect(stage.sent).toHaveLength(1)
	})

	it("is unresolved when the answer is no refusal, or the key is refused in its own tenant too", async () => {
		expect(await run(staged("notes.list", { cross: 500 }))).toEqual({
			kind: "unresolved",
			reason: "beta's apiKey key drew 500 under proj_a, neither a refusal nor a success",
		})
		expect(await run(staged("notes.list", { cross: 401, own: 401 }))).toEqual({
			kind: "unresolved",
			reason: "beta's apiKey key was refused (401) in its own tenant too, so the refusal proves nothing",
		})
	})
})

describe("auth.cross-tenant-key-refused (2)", () => {
	it("plans only on a tenant-scoped GET that takes an API key, with a peer tenant", () => {
		expect(crossTenantKeyRefused.plan(staged("notes.list", { cross: 401 }, null).ctx)).toEqual({
			needs: "a principal of another tenant",
			ok: false,
		})
		expect(crossTenantKeyRefused.plan(staged("notes.update", { cross: 401 }).ctx)).toEqual({
			needs: "a GET; notes.update is probed by the write stage's checks",
			ok: false,
		})
		expect(crossTenantKeyRefused.plan(staged("auth.revoke", { cross: 401 }).ctx).ok).toBe(false)
		expect(crossTenantKeyRefused.plan(staged("gateway.health", { cross: 401 }).ctx)).toEqual({
			needs: "an alternative that takes an API key alone",
			ok: false,
		})
		expect(crossTenantKeyRefused.plan(staged("notes.get", { cross: 401 }).ctx)).toEqual({
			needs: "a path the actor's and the peer's scopes each fill, differently",
			ok: false,
		})
		const open = operationContextFor(modelOf(undeclaredDoc()), "notes.list", { peer: beta, principals: [alpha, beta] })
		expect(crossTenantKeyRefused.plan(open.ctx)).toEqual({
			needs: "the document declares no security; add an overlay",
			ok: false,
		})
	})

	it("needs a path the two scopes fill differently", () => {
		const twin = actorOf("twin", { scope: { project_id: "proj_a" }, tenant: "other" })
		const stage = operationContextFor(model, "notes.list", { peer: twin, principals: [alpha, twin] })
		expect(crossTenantKeyRefused.plan(stage.ctx).ok).toBe(false)
		const flat = operationContextFor(model, "gateway.health", { peer: beta, principals: [alpha, beta] })
		expect(crossTenantKeyRefused.plan(flat.ctx).ok).toBe(false)
	})

	it("is inconclusive, never a pass, when validation answers before authorization", async () => {
		expect(await run(staged("notes.list", { cross: 400 }))).toEqual({
			kind: "unresolved",
			reason: `beta's apiKey key drew 400 under proj_a: ${BY_VALIDATION}`,
		})
	})
})

describe("auth.cross-tenant-key-refused: a peer key the run cannot hold", () => {
	it("stands down untested with the reason when the peer's key is BLOCKED", async () => {
		const reason = "mint for beta/apiKey: apiKey.create answered 403"
		const stage = operationContextFor(model, "notes.list", {
			peer: beta,
			principals: [alpha, beta],
			respond: (sent) => {
				if (sender(sent) === "beta") throw new UnsatisfiedSecurity("blocked", reason)
				return undefined
			},
		})
		const planned = crossTenantKeyRefused.plan(stage.ctx)
		if (!planned.ok) throw new Error(planned.needs)
		expect(await crossTenantKeyRefused.run(stage.ctx, planned.value)).toEqual({
			kind: "stood-down",
			reason: `beta's apiKey key: ${reason}`,
		})
		expect(stage.findings.findings).toEqual([])
	})
})

/* A key is refused under proj_a and answered under proj_b, whoever sends it. */
const refusedInAlpha = (sent: Sent) => ({ status: sent.path.includes("proj_a") ? 403 : 200 })

describe("auth.cross-tenant-key-refused with a target the peer created", () => {
	it("still sends the peer's key to the actor's tenant: the peer is its deliberate sender", async () => {
		const stage = operationContextFor(model, "notes.list", {
			peer: beta,
			principals: [alpha, beta],
			respond: refusedInAlpha,
			target: {
				current: { id: "n1" },
				entity: "note",
				id: "n1",
				owner: "beta",
				params: { note_id: "n1", project_id: "proj_b" },
				path: "/projects/proj_b/notes/n1",
			},
		})
		expect(await run(stage)).toEqual({ kind: "asserted" })
		expect(stage.sent.map((s) => [s.path, s.options.as])).toEqual([
			["/projects/proj_a/notes", { principal: "beta", scheme: "apiKey" }],
			["/projects/proj_b/notes", { principal: "beta", scheme: "apiKey" }],
		])
	})
})
