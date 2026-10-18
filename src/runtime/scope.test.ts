import { describe, expect, it } from "vitest"
import { buildSpec } from "../reference/spec/build.ts"
import {
	buildScopeReport,
	describeRequested,
	GradeLedger,
	operationFor,
	planScope,
	resolveTargetScope,
	ScopeError,
	staticSubjects,
} from "./scope.ts"
import { buildModel, type SpecModel } from "../spec/graph.ts"
import { dereference } from "../spec/load.ts"
import type { OpenApiDocument } from "../spec/types.ts"
function referenceModel(): SpecModel {
	return buildModel(dereference(buildSpec() as OpenApiDocument).doc)
}

const names = (scope: { entities: readonly { name: string }[] }): string[] => scope.entities.map((e) => e.name)

describe("operation scope", () => {
	it("is full when nothing is requested", () => {
		const scope = resolveTargetScope(referenceModel(), {})
		expect(scope.mode).toBe("full")
		expect(names(scope)).toEqual(["job", "notice", "overview", "profile", "row", "table"])
		expect(scope.inScope("table.get")).toBe(true)
		expect(scope.untestable.size).toBe(0)
	})

	it("targets exact operationIds and queues the entities whose checks grade them", () => {
		const scope = resolveTargetScope(referenceModel(), { ops: ["table.get"] })
		expect(scope.mode).toBe("targeted")
		expect([...scope.targets]).toEqual(["table.get"])
		/* row.create declares x-invalidate on table.get, so row's invalidation check grades it. */
		expect(names(scope)).toEqual(["row", "table"])
		expect(scope.inScope("table.get")).toBe(true)
		expect(scope.inScope("table.list")).toBe(false)
	})

	it("expands globs within an operationId", () => {
		const scope = resolveTargetScope(referenceModel(), { ops: ["row.*"] })
		expect([...scope.targets].sort()).toEqual(["row.create", "row.delete", "row.get", "row.list", "row.update"])
		expect(names(scope)).toEqual(["row"])
	})

	it("rejects an operationId that matches nothing and suggests the nearest", () => {
		expect(() => resolveTargetScope(referenceModel(), { ops: ["table.craete"] })).toThrow(ScopeError)
		expect(() => resolveTargetScope(referenceModel(), { ops: ["table.craete"] })).toThrow(/table\.create/)
		expect(() => resolveTargetScope(referenceModel(), { ops: ["nothing.*"] })).toThrow(/matches no operation/)
	})

	it("expands --only into every operation the entity owns, as a union with --ops", () => {
		const viaOnly = resolveTargetScope(referenceModel(), { only: ["job"] })
		const viaOps = resolveTargetScope(referenceModel(), { ops: ["job.*"] })
		expect([...viaOnly.targets].sort()).toEqual([...viaOps.targets].sort())
		expect(viaOnly.targets.has("job.start")).toBe(true)
		const union = resolveTargetScope(referenceModel(), { only: ["job"], ops: ["table.get"] })
		expect(union.targets.has("table.get")).toBe(true)
		expect(union.targets.has("job.list")).toBe(true)
		expect(union.requested).toEqual({ only: ["job"], ops: ["table.get"] })
	})

	it("rejects an --only entity that does not exist", () => {
		expect(() => resolveTargetScope(referenceModel(), { only: ["tabel"] })).toThrow(ScopeError)
		expect(() => resolveTargetScope(referenceModel(), { only: ["tabel"] })).toThrow(/table/)
	})

	it("suggests a secondary origin's entities too when --only names nothing", () => {
		const origins = new Map([["cdn", referenceModel()]])
		expect(() => resolveTargetScope(referenceModel(), { only: ["jbo"], origins })).toThrow(/Did you mean: job/)
	})

	it("names why a target can never be graded", () => {
		const scope = resolveTargetScope(referenceModel(), { ops: ["auth.token", "table.get"] })
		expect(scope.untestable.get("auth.token")).toMatch(/^unmodeled:/)
		expect(scope.untestable.has("table.get")).toBe(false)
	})

	it("refuses an exact target the profile excludes, and drops glob matches it excludes", () => {
		const exclusion = {
			profile: "cheap",
			reason: (op: { operationId: string }) => (op.operationId === "job.start" ? "x-cost: high" : null),
		}
		expect(() => resolveTargetScope(referenceModel(), { exclusion, ops: ["job.start"] })).toThrow(
			/job\.start is excluded by --profile cheap \(x-cost: high\)/,
		)
		const scope = resolveTargetScope(referenceModel(), { exclusion, ops: ["job.*"] })
		expect(scope.targets.has("job.start")).toBe(false)
		expect(scope.targets.has("job.list")).toBe(true)
		expect(scope.excluded).toEqual([{ operationId: "job.start", reason: "x-cost: high" }])
	})

	it("routes <origin>:<operationId> to that origin and validates against its model", () => {
		const origins = new Map([["cdn", referenceModel()]])
		const scope = resolveTargetScope(referenceModel(), { ops: ["cdn:table.get"], origins })
		expect(scope.mode).toBe("targeted")
		expect(scope.targets.size).toBe(0)
		expect(names(scope)).toEqual([])
		expect(scope.origins.get("cdn")).toEqual(["table.get"])
		expect(() => resolveTargetScope(referenceModel(), { ops: ["cdn:nope"], origins })).toThrow(ScopeError)
	})

	it("derives subjects statically from the entity graph", () => {
		const model = referenceModel()
		const table = model.entities.get("table")
		const row = model.entities.get("row")
		const job = model.entities.get("job")
		if (table === undefined || row === undefined || job === undefined) throw new Error("reference entities")
		expect([...staticSubjects(table, model)].sort()).toEqual([
			"invite.accept",
			"table.create",
			"table.delete",
			"table.get",
			"table.invite",
			"table.list",
			"table.revoke",
			"table.update",
		])
		const rowSubjects = staticSubjects(row, model)
		expect(rowSubjects.has("table.get")).toBe(true)
		expect(rowSubjects.has("table.list")).toBe(true)
		expect(rowSubjects.has("table.create")).toBe(false)
		expect(staticSubjects(job, model).has("job.start")).toBe(true)
	})
})

const doc = {
	info: { title: "vacuous", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/pay": { post: { operationId: "pay.start", responses: { "200": { description: "ok" } } } },
	},
} as unknown as OpenApiDocument

function report(ledger: GradeLedger, transcript: unknown[], blocked = false) {
	const model = buildModel(doc)
	return buildScopeReport({
		authCreates: new Set(),
		baseUrl: "http://api.test",
		findings: blocked
			? [
					{
						check: "scenario.pay",
						detail: "blocked by scenario stopped at step 2",
						entity: "pay",
						evidence: [],
						operations: ["pay.start"],
						summary: "scenario stopped",
						verdict: "BLOCKED",
					},
				]
			: [],
		inconclusive: [],
		ledger,
		model,
		scope: resolveTargetScope(model, { ops: ["pay.start"] }),
		transcript: transcript as never,
	}).operations[0]
}

describe("a pass needs a call", () => {
	it("does not count a check that graded an operation it never called", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "spec.declared-rate-limit-is-honoured")
		const row = report(ledger, [])
		expect(row?.status).toBe("untested")
		expect(row?.reason).toContain("no request to pay.start succeeded")
	})

	it("keeps a block when the only pass came from a check that never called it", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "spec.declared-rate-limit-is-honoured")
		expect(report(ledger, [], true)?.status).toBe("blocked")
	})

	it("passes once a successful call exists", () => {
		const ledger = new GradeLedger()
		ledger.graded(["pay.start"], "spec.declared-rate-limit-is-honoured")
		const call = { method: "POST", operationId: "pay.start", seq: 1, status: 200, url: "http://api.test/v1/pay" }
		expect(report(ledger, [call])?.status).toBe("passed")
	})
})

describe("planning a scope without a network", () => {
	it("says what was asked, as typed", () => {
		expect(describeRequested({ only: ["row"], ops: ["table.get", "table.list"] })).toBe(
			"--ops table.get,table.list --only row",
		)
		expect(describeRequested({ only: [], ops: [] })).toBe("")
	})

	it("finds the operation an exchange hit, below the base path, or none", () => {
		const model = referenceModel()
		const table = operationFor(model, "GET", "http://h.test/api/v1/projects/p1/tables/t1", "http://h.test/api")
		expect(table?.operationId).toBe("table.get")
		expect(operationFor(model, "GET", "http://h.test/api/nowhere", "http://h.test/api")).toBeNull()
		expect(operationFor(model, "GET", "not a url", "http://h.test")).toBeNull()
	})

	it("names each target's grading checks and the entities a targeted run queues", () => {
		const model = referenceModel()
		const plan = planScope(model, resolveTargetScope(model, { ops: ["table.get"] }))
		expect(plan.mode).toBe("targeted")
		expect(plan.targets.map((target) => target.operationId)).toEqual(["table.get"])
		expect(plan.targets[0]?.checks.length).toBeGreaterThan(0)
		expect(plan.entities).toContain("table")
	})
})
