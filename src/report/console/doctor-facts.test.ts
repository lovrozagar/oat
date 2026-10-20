import { describe, expect, it } from "vitest"
import { documentOf, listOp, modelOf, referenceModel } from "./__fixtures__/models.ts"
import { doctorFacts } from "./doctor-facts.ts"

describe("doctorFacts and the gaps of a recipe's operations", () => {
	it("drops a gap on an operation a recipe sends, and keeps every other", async () => {
		const { model } = await referenceModel()
		const all = doctorFacts(model).gapsByTag.get("x-entity") ?? []
		const kept = doctorFacts(model, { authCreates: new Set(["auth.token"]) })
		expect(all.map((gap) => gap.operationId)).toContain("auth.token")
		expect(kept.gapsByTag.get("x-entity")).toHaveLength(all.length - 1)
		expect(kept.gaps.map((gap) => gap.operationId)).not.toContain("auth.token")
	})
})

describe("doctorFacts", () => {
	it("counts what a run can follow and list, and blocks on roots it must be given", async () => {
		const facts = doctorFacts((await referenceModel()).model)
		expect(facts.entities.map((entity) => entity.name)).toEqual([
			"job",
			"notice",
			"overview",
			"profile",
			"row",
			"table",
		])
		expect(facts.trackable).toHaveLength(6)
		expect(facts.listable.map((entity) => entity.name)).toEqual(["job", "notice", "row", "table"])
		expect(facts.blocking).toBe(1)
		expect(facts.uniqueConstraints).toEqual([{ entity: "table", unique: [["name"]] }])
		expect(facts.inviting.map((entity) => entity.name)).toEqual(["table"])
		expect(facts.featureGates).toEqual([])
		expect([...facts.gapsByTag.keys()].sort()).toEqual(["x-entity", "x-tenant"])
		expect(facts.gapsByTag.get("x-entity")).toHaveLength(4)
		expect(facts.catalogs).toHaveLength(4)
		expect(facts.unknownEntities).toEqual([])
	})

	it("blocks on every entity it cannot follow, and lists feature gates", () => {
		const facts = doctorFacts(
			modelOf(
				documentOf({
					"/a": { get: listOp("a", "a.list", { "x-feature-gate": "beta" }) },
					"/c": {
						post: {
							operationId: "c.create",
							requestBody: { content: { "application/json": { schema: { type: "object" } } } },
							responses: { "201": { description: "made" } },
							"x-entity": { action: "create", name: "c" },
						},
					},
				}),
			).model,
			{ entities: { b: {} } },
		)
		expect(facts.featureGates).toEqual([{ featureGate: "beta", operationId: "a.list" }])
		expect(facts.trackable.length).toBeLessThan(facts.entities.length)
		expect(facts.blocking).toBe(facts.entities.length - facts.trackable.length)
		expect(facts.unknownEntities).toEqual(["b"])
	})

	it("finds nothing in an empty document", () => {
		const facts = doctorFacts(modelOf(documentOf({})).model)
		expect(facts.blocking).toBe(0)
		expect(facts.gapsByTag.size).toBe(0)
	})
})
