import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import { modelOf, type Sent } from "../../__fixtures__/harness.ts"
import type { Actor } from "../../core/context.ts"
import type { WriteTarget } from "../../core/operation-context.ts"
import { applyingBackend, untouched } from "./__fixtures__/applying.ts"
import { actorOf, operationContextFor, type SentResponder, sender } from "./__fixtures__/operation-context.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { roleEnforced } from "./auth-role-enforced.ts"
import { BY_VALIDATION } from "./probing.ts"

/* A principal the config marks readOnly cannot write: its write to a run-created record must be refused. */

const model = modelOf(securedDoc())
const alpha = actorOf("alpha", { rank: 2, scope: { project_id: "proj_a" }, tenant: "proj_a" })
const member = actorOf("alpha_member", { rank: 1, scope: { project_id: "proj_a" }, tenant: "proj_a" })
const viewer = actorOf("alpha_viewer", { rank: 0, readOnly: true, scope: { project_id: "proj_a" }, tenant: "proj_a" })
/* Rank 0, but not marked: whether it may write is the API's business, not this check's. */
const guest = actorOf("alpha_guest", { rank: 0, scope: { project_id: "proj_a" }, tenant: "proj_a" })
const betaViewer = actorOf("beta_viewer", { readOnly: true, scope: { project_id: "proj_b" }, tenant: "proj_b" })
const beta = actorOf("beta", { rank: 0, scope: { project_id: "proj_b" }, tenant: "proj_b" })
const TEAM: [Actor, ...Actor[]] = [alpha, beta, member, viewer]

interface Staging {
	respond?: SentResponder
	principals?: [Actor, ...Actor[]]
	target?: WriteTarget | null
}

function staged(operationId: string, { respond, principals = TEAM, target = NOTE_TARGET }: Staging = {}) {
	return operationContextFor(model, operationId, {
		principals,
		...(respond === undefined ? {} : { respond }),
		...(target === null ? {} : { target }),
	})
}

const viewerGets =
	(status: number): SentResponder =>
	(sent: Sent) =>
		sender(sent) === "alpha_viewer" ? { status } : undefined

describe("auth.role-enforced", () => {
	it("passes when the read-only principal's write on the run-created record is refused", async () => {
		for (const status of [401, 403]) {
			const stage = staged("notes.update", { respond: viewerGets(status) })
			expect(await runOperationCheck(roleEnforced, stage.ctx)).toEqual({ kind: "asserted" })
			expect(stage.sent.map((s) => [s.method, s.path, s.options.as, s.options.body, s.options.probe])).toEqual([
				["PATCH", NOTE_TARGET.path, { principal: "alpha_viewer" }, { title: "first" }, true],
			])
		}
		expect(roleEnforced.mutates).toBe(true)
	})

	it("sends a delete with no body", async () => {
		const stage = staged("notes.delete", { respond: viewerGets(403) })
		expect(await runOperationCheck(roleEnforced, stage.ctx)).toEqual({ kind: "asserted" })
		expect(stage.sent.map((s) => [s.method, s.path, s.options.body])).toEqual([["DELETE", NOTE_TARGET.path, undefined]])
	})

	it("reports a security finding when the write is accepted, having touched only the run-created record harmlessly", async () => {
		const backend = applyingBackend()
		const stage = staged("notes.update", { respond: backend.respond })
		expect(await runOperationCheck(roleEnforced, stage.ctx)).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(stage.findings.findings).toMatchObject([
			{
				check: "auth.role-enforced",
				detail: expect.stringMatching(/alpha_viewer, marked readOnly.*proj_a.*notes\.update answered 200/),
				summary: "a read-only principal's write is accepted",
			},
		])
		/* What the backend applied is the record's own writable state: nothing changed. */
		expect(backend.records).toEqual(untouched())
	})

	it("is inconclusive, never a pass, when validation answers before authorization", async () => {
		expect(await runOperationCheck(roleEnforced, staged("notes.update", { respond: viewerGets(400) }).ctx)).toEqual({
			kind: "unresolved",
			reason: `alpha_viewer's write drew 400: ${BY_VALIDATION}`,
		})
	})

	it("is unresolved on an answer that is neither a refusal nor a success", async () => {
		expect(await runOperationCheck(roleEnforced, staged("notes.update", { respond: viewerGets(500) }).ctx)).toEqual({
			kind: "unresolved",
			reason: "alpha_viewer's write drew 500, neither a refusal nor a success",
		})
	})
})

describe("auth.role-enforced (2)", () => {
	it("stands down on a read, an anonymous write, without a target or without a read-only principal", async () => {
		const reasons = await Promise.all(
			[
				staged("notes.list"),
				staged("auth.refresh"),
				staged("notes.update", { target: null }),
				staged("notes.update", { principals: [alpha, member, beta] }),
				staged("notes.update", { principals: [alpha, member, betaViewer] }),
				staged("notes.update", { target: { ...NOTE_TARGET, current: undefined } }),
				operationContextFor(modelOf(undeclaredDoc()), "notes.update", { principals: TEAM, target: NOTE_TARGET }),
			].map(async (stage) => runOperationCheck(roleEnforced, stage.ctx)),
		)
		expect(reasons.map((outcome) => ("reason" in outcome ? outcome.reason : outcome.kind))).toEqual([
			"a write method",
			"a write the document secures",
			"a record this run created that notes.update can be sent to",
			"no principal is marked readOnly",
			"a readOnly principal sharing the target owner's tenant",
			"the target record's current state, for a harmless body",
			"the document declares no security; add an overlay",
		])
	})

	it("never flags an unmarked rank-0 principal that can write", async () => {
		const backend = applyingBackend()
		const stage = staged("notes.update", { principals: [alpha, guest, member], respond: backend.respond })
		expect(await runOperationCheck(roleEnforced, stage.ctx)).toEqual({
			kind: "stood-down",
			reason: "no principal is marked readOnly",
		})
		expect([stage.sent, stage.findings.findings]).toEqual([[], []])
	})

	it("finds the target owner among the principals, else judges the actor's tenant", async () => {
		const stage = staged("notes.update", {
			respond: viewerGets(403),
			target: { ...NOTE_TARGET, owner: "gone" },
		})
		expect(await runOperationCheck(roleEnforced, stage.ctx)).toEqual({ kind: "asserted" })
	})
})

describe("auth.role-enforced: a read-only principal the run cannot send as", () => {
	it("stands down untested with the reason when its credential is BLOCKED", async () => {
		const reason = "refresh for alpha_viewer/jwt: auth step 1 answered 401"
		const stage = staged("notes.update", {
			respond: (sent) => {
				if (sender(sent) === "alpha_viewer") throw new UnsatisfiedSecurity("blocked", reason)
				return undefined
			},
		})
		expect(await runOperationCheck(roleEnforced, stage.ctx)).toEqual({
			kind: "stood-down",
			reason: `alpha_viewer's write: ${reason}`,
		})
		expect(stage.findings.findings).toEqual([])
	})
})
