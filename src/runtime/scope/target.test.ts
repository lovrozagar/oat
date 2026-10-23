import { describe, expect, it } from "vitest"
import { referenceModel } from "./__fixtures__/models.ts"
import { ScopeError } from "./scope-error.ts"
import { resolveTargetScope } from "./target.ts"

const names = (scope: { entities: readonly { name: string }[] }): string[] => scope.entities.map((e) => e.name)

describe("operation scope", () => {
	it("is full when nothing is requested", () => {
		const scope = resolveTargetScope(referenceModel(), { ops: [" "], only: [] })
		expect(scope.mode).toBe("full")
		expect(names(scope)).toEqual(["api-key", "job", "notice", "overview", "profile", "row", "table", "webhook"])
		expect(scope.inScope("table.get")).toBe(true)
		expect(scope.untestable.size).toBe(0)
		expect(resolveTargetScope(referenceModel(), {}).requested).toEqual({ only: [], ops: [] })
	})

	it("targets exact operationIds and queues the entities whose checks grade them", () => {
		const scope = resolveTargetScope(referenceModel(), { ops: [" table.get "] })
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
})

describe("operation scope by entity and origin", () => {
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

	it("counts auth creates, and keeps only origins with a target", () => {
		const exclusion = { profile: "cheap", reason: () => "x-cost: high" }
		const scope = resolveTargetScope(referenceModel(), {
			authCreates: new Set(["row.create"]),
			exclusion,
			ops: ["cdn:job.*", "auth.*"],
			origins: new Map([["cdn", referenceModel()]]),
		})
		expect(scope.origins.size).toBe(0)
		expect(scope.excluded.map((excluded) => excluded.operationId)).toContain("cdn:job.start")
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
})
