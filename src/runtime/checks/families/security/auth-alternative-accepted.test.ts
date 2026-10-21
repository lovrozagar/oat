import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import { modelOf } from "../../__fixtures__/harness.ts"
import { actorOf, operationContextFor, type SentResponder } from "./__fixtures__/operation-context.ts"
import { runOperationCheck } from "./__fixtures__/run.ts"
import { NOTE_TARGET, securedDoc, undeclaredDoc } from "./__fixtures__/secured-api.ts"
import { alternativeAccepted, controlOf } from "./auth-alternative-accepted.ts"

const ok = { "200": { description: "ok" } }
const model = modelOf(
	securedDoc({
		"/optional": { get: { operationId: "optional.read", responses: ok, security: [{}, { jwt: [] }] } },
		"/paired": {
			get: { operationId: "paired.read", responses: ok, security: [{ apiKey: [], jwt: [] }, { apiKey: ["x"] }] },
		},
	}),
)
const principals = [actorOf("alpha", { scope: { project_id: "proj_a" } })] as [ReturnType<typeof actorOf>]
const scheme = (sent: { options: { as: object } }): string =>
	"scheme" in sent.options.as ? String(sent.options.as.scheme) : "principal" in sent.options.as ? "first" : "anonymous"

/* Answers by the scheme the request named: a status, or an error thrown before anything is sent. */
const by =
	(answers: Record<string, number | Error>): SentResponder =>
	(sent) => {
		const answer = answers[scheme(sent)] ?? 200
		if (answer instanceof Error) throw answer
		return { status: answer }
	}

describe("auth.alternative-accepted", () => {
	it("sends each alternative besides the first on its own, as the principal, and passes when it is answered", async () => {
		const { ctx, findings, sent } = operationContextFor(model, "notes.list", { principals, respond: by({}) })
		expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => [s.method, s.path, s.options])).toEqual([
			["GET", "/projects/proj_a/notes", { as: { principal: "alpha", scheme: "apiKey" }, operationId: "notes.list" }],
		])
		expect(findings.findings).toEqual([])
	})

	it("reports BACKEND_BUG when the alternative is refused and the first is answered", async () => {
		for (const status of [401, 403]) {
			const { ctx, findings, sent } = operationContextFor(model, "notes.list", {
				principals,
				respond: by({ apiKey: status }),
			})
			expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
			expect(sent.map((s) => s.options.as)).toEqual([
				{ principal: "alpha", scheme: "apiKey" },
				{ principal: "alpha", scheme: "jwt" },
			])
			expect(findings.findings.map((f) => [f.summary, f.detail, f.evidence.map((e) => e.status)])).toEqual([
				[
					"an operation refused a credential one of its documented alternatives accepts",
					`notes.list answered ${status} to alpha's apiKey credential, though the document accepts apiKey with notes:read on its own. The same request with jwt answered 200.`,
					[status, 200],
				],
			])
		}
	})
})

describe("auth.alternative-accepted: a first alternative that is not refused", () => {
	it("is unresolved when the first alternative is not refused but does not succeed either: no proof of access", async () => {
		for (const status of [404, 500]) {
			const { ctx, findings } = operationContextFor(model, "notes.list", {
				principals,
				respond: by({ apiKey: 403, jwt: status }),
			})
			expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({
				kind: "unresolved",
				reason: `notes.list answered jwt with ${status}, not a success, so the refusal of apiKey says nothing of that alternative`,
			})
			expect(findings.findings.filter((f) => f.verdict === "BACKEND_BUG")).toEqual([])
		}
	})
})

describe("auth.alternative-accepted when it cannot judge", () => {
	it("is unresolved when the first alternative is refused too", async () => {
		const { ctx } = operationContextFor(model, "notes.list", { principals, respond: by({ apiKey: 401, jwt: 403 }) })
		expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({
			kind: "unresolved",
			reason: "notes.list refused jwt as well (403), so the refusal of apiKey says nothing of that alternative",
		})
	})

	it("is unresolved when the first alternative cannot be sent", async () => {
		const blocked = new UnsatisfiedSecurity("blocked", "alpha is BLOCKED for jwt")
		const { ctx } = operationContextFor(model, "notes.list", { principals, respond: by({ apiKey: 401, jwt: blocked }) })
		expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({
			kind: "unresolved",
			reason: "notes.list refused apiKey, and jwt could not be sent to compare: alpha is BLOCKED for jwt",
		})
	})

	it("is untested for an alternative the principal cannot satisfy", async () => {
		const unsatisfied = new UnsatisfiedSecurity("unsatisfied", "no credential for apiKey")
		const { ctx } = operationContextFor(model, "notes.list", { principals, respond: by({ apiKey: unsatisfied }) })
		expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({
			kind: "stood-down",
			reason: "no credential for apiKey",
		})
	})

	it("lets any other failure through to the stage", async () => {
		const { ctx } = operationContextFor(model, "notes.list", {
			principals,
			respond: by({ apiKey: new Error("socket") }),
		})
		await expect(runOperationCheck(alternativeAccepted, ctx)).rejects.toThrow("socket")
	})

	it("compares with the first alternative as it is: anonymous, one scheme, or the principal's choice of a set", () => {
		const optional = operationContextFor(model, "optional.read").ctx
		expect(controlOf(optional)).toEqual({ as: { anonymous: true }, named: "no credential" })
		expect(controlOf(operationContextFor(model, "notes.list").ctx)).toEqual({
			as: { principal: "alpha", scheme: "jwt" },
			named: "jwt",
		})
		expect(controlOf(operationContextFor(model, "paired.read").ctx)).toEqual({
			as: { principal: "alpha" },
			named: "apiKey and jwt",
		})
	})

	it("probes an operation that lets anonymous callers in, comparing with no credential", async () => {
		const { ctx, findings } = operationContextFor(model, "optional.read", { respond: by({ anonymous: 200, jwt: 401 }) })
		expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toContain("The same request with no credential answered 200.")
	})
})

describe("auth.alternative-accepted planning", () => {
	it("is read-only: it runs before the lanes", () => {
		expect(alternativeAccepted.mutates).toBeUndefined()
		expect(alternativeAccepted.subject).toBe("operation")
	})

	it("stands down on a write, without a second single-scheme alternative, and where nothing is declared", () => {
		expect(alternativeAccepted.plan(operationContextFor(model, "notes.update").ctx)).toEqual({
			needs: "a read: a write an alternative is accepted on would apply it",
			ok: false,
		})
		expect(alternativeAccepted.plan(operationContextFor(model, "auth.revoke").ctx).ok).toBe(false)
		expect(alternativeAccepted.plan(operationContextFor(model, "feed.list").ctx)).toEqual({
			needs: "a value for project_id in feed.list's path",
			ok: false,
		})
		expect(alternativeAccepted.plan(operationContextFor(model, "gateway.health").ctx)).toEqual({
			needs: "an alternative of one scheme besides the first",
			ok: false,
		})
		expect(alternativeAccepted.plan(operationContextFor(modelOf(undeclaredDoc()), "notes.list").ctx).ok).toBe(false)
	})
})

/* A note beta created in its own project: an item read's target, which alpha has no access to. */
const BETA_TARGET = {
	...NOTE_TARGET,
	owner: "beta",
	params: { note_id: "n1", project_id: "proj_b" },
	path: "/projects/proj_b/notes/n1",
}
const team = [
	actorOf("alpha", { scope: { project_id: "proj_a" }, tenant: "t1" }),
	actorOf("beta", { scope: { project_id: "proj_b" }, tenant: "t2" }),
] as [ReturnType<typeof actorOf>, ...ReturnType<typeof actorOf>[]]

/* Answers beta, the record's creator; anyone else finds no such record. */
const asBeta: SentResponder = (s) => ({
	status: "principal" in s.options.as && s.options.as.principal === "beta" ? 200 : 404,
})

describe("auth.alternative-accepted on a record another principal created", () => {
	it("acts as the record's creator, so the alternative is judged where access is expected", async () => {
		const { ctx, sent } = operationContextFor(model, "notes.get", {
			placement: "item-read",
			principals: team,
			respond: asBeta,
			target: BETA_TARGET,
		})
		expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => [s.path, s.options.as])).toEqual([
			["/projects/proj_b/notes/n1", { principal: "beta", scheme: "apiKey" }],
		])
	})

	it("judges the creator's alternative against the creator's first, and names the creator", async () => {
		const { ctx, findings, sent } = operationContextFor(model, "notes.get", {
			placement: "item-read",
			principals: team,
			respond: by({ apiKey: 403 }),
			target: BETA_TARGET,
		})
		expect(await runOperationCheck(alternativeAccepted, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(sent.map((s) => s.options.as)).toEqual([
			{ principal: "beta", scheme: "apiKey" },
			{ principal: "beta", scheme: "jwt" },
		])
		expect(findings.findings[0]?.detail).toMatch(/^notes\.get answered 403 to beta's apiKey credential/)
	})
})
