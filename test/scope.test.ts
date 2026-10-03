import { describe, expect, it } from "vitest"
import { buildSpec } from "../src/reference/spec.ts"
import { resolveTargetScope, ScopeError, staticSubjects } from "../src/runtime/scope.ts"
import { buildModel, type SpecModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

function referenceModel(): SpecModel {
	return buildModel(dereference(buildSpec() as OpenApiDocument).doc)
}

const names = (scope: { entities: readonly { name: string }[] }): string[] => scope.entities.map((e) => e.name)

describe("operation scope", () => {
	it("is full when nothing is requested", () => {
		const scope = resolveTargetScope(referenceModel(), {})
		expect(scope.mode).toBe("full")
		expect(names(scope)).toEqual(["job", "row", "table"])
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
