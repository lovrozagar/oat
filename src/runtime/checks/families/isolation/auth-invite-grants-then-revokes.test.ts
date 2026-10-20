import { describe, expect, it } from "vitest"
import { modelOf, type Responder, type Sent } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { inviteGrantsThenRevokes } from "./auth-invite-grants-then-revokes.ts"
import { actor, caller } from "./__fixtures__/context.ts"
import { delegate, GATED, inviteBackend, inviteContext, inviteDocument, owner } from "./__fixtures__/invites.ts"

const line = (s: Sent) => `${s.method} ${s.path} ${caller(s)}`
const FLOW = [
	"GET /orgs/o1/notes/n1 delegate",
	"POST /orgs/o1/notes/n1/invites owner",
	"GET /orgs/o1/notes/n1 delegate",
	"POST /invites/t1/accept delegate",
	"GET /orgs/o1/notes/n1 delegate",
	"DELETE /orgs/o1/notes/n1/invites/g1 owner",
	"GET /orgs/o1/notes/n1 delegate",
]

describe("auth.invite-grants-then-revokes", () => {
	it("passes when access starts at accept and ends at revoke", async () => {
		const { ctx, findings, sent } = inviteContext(inviteDocument(), inviteBackend())
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map(line)).toEqual(FLOW)
		expect(sent[1]?.options.body).toEqual({ key: "bob" })
		/* The owner's credential is the client's to place: the check sends only the body's type. */
		expect(sent[1]?.options.headers).toEqual({ "content-type": "application/json" })
		expect(sent.map((s) => s.options.operationId)).toEqual([
			"readNote",
			"inviteNote",
			"readNote",
			"acceptInvite",
			"readNote",
			"revokeInvite",
			"readNote",
		])
		expect(sent[3]?.options.body).toBeUndefined()
		expect(findings.findings).toEqual([])
	})

	it("reports an invite that grants access before it is accepted, and still revokes it", async () => {
		const { ctx, findings, sent } = inviteContext(inviteDocument(), inviteBackend({ grantsBeforeAccept: true }))
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("an invite grants access before it is accepted")
		expect(findings.findings[0]?.detail).toContain("inviting delegate made note n1 readable immediately")
		expect(sent.map(line)).toEqual([...FLOW.slice(0, 3), "DELETE /orgs/o1/notes/n1/invites/g1 owner"])
	})

	it("reports an accepted invite that never grants access (INVITE_NEVER_GRANTS)", async () => {
		const { ctx, findings, sent } = inviteContext(inviteDocument(), inviteBackend({ neverGrants: true }))
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("accepting an invite does not grant access")
		expect(findings.findings[0]?.evidence.map((e) => e.status)).toEqual([201, 200])
		expect(sent.map(line)).toEqual([...FLOW.slice(0, 5), "DELETE /orgs/o1/notes/n1/invites/g1 owner"])
	})

	it("reports access that survives revoke (REVOKE_IGNORED), revoking once", async () => {
		const { ctx, findings, sent } = inviteContext(inviteDocument(), inviteBackend({ revokeIgnored: true }))
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings[0]?.summary).toBe("revoking an invite does not remove access")
		expect(findings.findings[0]?.evidence.map((e) => e.status)).toEqual([201, 200, 204])
		expect(sent.map(line)).toEqual(FLOW)
	})
})

describe("auth.invite-grants-then-revokes: what the grant opens", () => {
	it("is unresolved when the delegate could read before any invite", async () => {
		const { ctx, sent } = inviteContext(inviteDocument(), inviteBackend({ alreadyShared: true }))
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({
			kind: "unresolved",
			reason: "the delegate could already read the record, so invite cannot be distinguished from a leak",
		})
		expect(sent).toHaveLength(1)
	})

	it("judges the read the grant names, filled from the inviter's scope", async () => {
		const doc = inviteDocument({ tag: { grants: "sharedNotes" } })
		const { ctx, findings, sent } = inviteContext(doc, inviteBackend({ neverGrants: true }))
		await runCheck(inviteGrantsThenRevokes, ctx)
		expect(sent[0]?.path).toBe("/orgs/o1/shared")
		expect(sent[0]?.options.operationId).toBe("sharedNotes")
		expect(findings.findings[0]?.detail).toContain("still cannot read sharedNotes on the inviter's scope")
	})

	it("runs the flow without a verdict on access when there is no read to try", async () => {
		const doc = inviteDocument({
			invitePath: "/orgs/{org_id}/invites",
			revokePath: "/orgs/{org_id}/invites/{grant_id}",
		})
		for (const fields of [{ readOp: undefined }, { records: [{ title: "first" }] }]) {
			const backend = inviteBackend({ neverGrants: true })
			const { ctx, findings, sent } = inviteContext(doc, backend, fields)
			expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "asserted" })
			expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
				"POST /orgs/o1/invites",
				"POST /invites/t1/accept",
				"DELETE /orgs/o1/invites/g1",
			])
			expect(findings.findings).toEqual([])
		}
	})
})

describe("auth.invite-grants-then-revokes when a step does not complete", () => {
	it("stands down when a documented feature gate refuses the invite, accept or revoke", async () => {
		for (const [request, count] of [
			["POST /orgs/o1/notes/n1/invites", 2],
			/* Refused at accept, the grant is still taken back. */
			["POST /invites/t1/accept", 5],
			["DELETE /orgs/o1/notes/n1/invites/g1", 6],
		] as const) {
			const { ctx, findings, sent } = inviteContext(inviteDocument(), inviteBackend({ override: { [request]: GATED } }))
			expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({
				kind: "stood-down",
				reason: "a documented feature gate refused the request",
			})
			expect(findings.byVerdict("COVERAGE_GAP")).toHaveLength(1)
			expect(sent).toHaveLength(count)
		}
	})

	it("is unresolved when the invite, accept or revoke fails", async () => {
		for (const [request, reason] of [
			["POST /orgs/o1/notes/n1/invites", "invite returned 500, so accept/revoke were never exercised"],
			["POST /invites/t1/accept", "accept returned 500"],
			["DELETE /orgs/o1/notes/n1/invites/g1", "revoke returned 500"],
		] as const) {
			const backend = inviteBackend({ override: { [request]: { status: 500 } } })
			const { ctx } = inviteContext(inviteDocument(), backend)
			expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "unresolved", reason })
		}
	})
})

describe("auth.invite-grants-then-revokes when the invite answer lacks a value", () => {
	it("is unresolved without a token in the invite's answer, revoking what it granted", async () => {
		const { ctx, sent } = inviteContext(inviteDocument(), inviteBackend({ invited: { grant_id: "g1" } }))
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({
			kind: "unresolved",
			reason: "invite response has no token at $.token",
		})
		expect(sent.map(line).at(-1)).toBe("DELETE /orgs/o1/notes/n1/invites/g1 owner")
	})

	it("is unresolved without a grant id, and has nothing to revoke", async () => {
		const { ctx, sent } = inviteContext(inviteDocument(), inviteBackend({ invited: { grant_id: 7, token: "t1" } }))
		expect((await runCheck(inviteGrantsThenRevokes, ctx)).kind).toBe("asserted")
		expect(sent[5]?.path).toBe("/orgs/o1/notes/n1/invites/7")
		const missing = inviteContext(inviteDocument(), inviteBackend({ invited: { token: "t1" } }))
		expect(await runCheck(inviteGrantsThenRevokes, missing.ctx)).toEqual({
			kind: "unresolved",
			reason: "invite response has no grant id at $.grant_id, so revoke cannot be expressed",
		})
		expect(missing.sent.map((s) => s.method)).not.toContain("DELETE")
	})

	it("returns its finding even when the cleanup revoke fails to send", async () => {
		const backend = inviteBackend({ grantsBeforeAccept: true })
		const failing: Responder = (method, path, options) => {
			if (method === "DELETE") throw new Error("connection reset")
			return backend(method, path, options)
		}
		const { ctx } = inviteContext(inviteDocument(), failing)
		expect(await runCheck(inviteGrantsThenRevokes, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})
})

describe("auth.invite-grants-then-revokes planning", () => {
	it("picks a delegate in another tenant, else a peer in the same one", () => {
		/* Same tenant as the owner, though its scope names another org: tenant decides, not scope. */
		const peer = actor("peer", { inviteAs: "pat", rank: 1, scope: { org_id: "o3" }, tenant: "o1" })
		const plain = actor("plain", { rank: 1, scope: { org_id: "o2" }, tenant: "o2" })
		const across = inviteContext(inviteDocument(), inviteBackend(), { actors: [owner, peer, delegate] })
		expect(inviteGrantsThenRevokes.plan(across.ctx)).toMatchObject({ ok: true, value: { delegate, inviteAs: "bob" } })
		const within = inviteContext(inviteDocument(), inviteBackend(), { actors: [owner, plain, peer] })
		expect(inviteGrantsThenRevokes.plan(within.ctx)).toMatchObject({ ok: true, value: { delegate: peer } })
		const nobody = inviteContext(inviteDocument(), inviteBackend(), { actors: [owner, plain] })
		expect(inviteGrantsThenRevokes.plan(nobody.ctx)).toEqual({
			needs: "a peer principal declaring inviteAs, so the grantee field need not be invented",
			ok: false,
		})
	})

	it("stands down without an invite tag or a principal", () => {
		for (const fields of [{ invite: null }, { actors: [] }]) {
			expect(inviteGrantsThenRevokes.plan(inviteContext(inviteDocument(), inviteBackend(), fields).ctx)).toEqual({
				ok: false,
			})
		}
	})

	it("names operations the tag points at that the document lacks", () => {
		for (const without of [["acceptInvite"], ["revokeInvite"]]) {
			const { ctx } = inviteContext(inviteDocument({ without }), inviteBackend())
			expect(inviteGrantsThenRevokes.plan(ctx)).toEqual({
				needs: "x-invite operations that exist in the document",
				ok: false,
			})
		}
		const { ctx } = inviteContext(inviteDocument({ tag: { grants: "nowhere" } }), inviteBackend())
		expect(inviteGrantsThenRevokes.plan(ctx)).toEqual({
			needs: "an x-invite.grants read that exists in the document",
			ok: false,
		})
	})

	it("grades the invite, accept and revoke", () => {
		const model = modelOf(inviteDocument())
		const entity = [...model.entities.values()].find((e) => e.invite !== null)
		expect(entity === undefined ? [] : inviteGrantsThenRevokes.subjects(entity, model)).toEqual([
			"inviteNote",
			"acceptInvite",
			"revokeInvite",
		])
	})
})
