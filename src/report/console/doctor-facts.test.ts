import { describe, expect, it } from "vitest"
import { documentOf, listOp, modelOf, referenceModel } from "./__fixtures__/models.ts"
import { doctorFacts } from "./doctor-facts.ts"

describe("doctorFacts and the operations a recipe names", () => {
	it("leaves out an entity whose operations a security recipe calls, as a run does", async () => {
		const { model } = await referenceModel()
		const facts = doctorFacts(model, { authCreates: new Set(["apiKey.create", "apiKey.revoke"]) })
		expect(facts.entities.map((entity) => entity.name)).not.toContain("api-key")
		expect([facts.entities.length, facts.trackable.length, facts.blocking]).toEqual([6, 6, 1])
	})
})

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
		/* The reference reads its API keys back (apiKey.get), so api-key is a trackable entity of its own. */
		expect(facts.entities.map((entity) => entity.name)).toEqual([
			"api-key",
			"job",
			"notice",
			"overview",
			"profile",
			"row",
			"table",
		])
		expect(facts.trackable).toHaveLength(7)
		expect(facts.listable.map((entity) => entity.name)).toEqual(["job", "notice", "row", "table"])
		expect(facts.blocking).toBe(1)
		expect(facts.uniqueConstraints).toEqual([{ entity: "table", unique: [["name"]] }])
		expect(facts.inviting.map((entity) => entity.name)).toEqual(["table"])
		expect(facts.featureGates).toEqual([])
		expect([...facts.gapsByTag.keys()].sort()).toEqual(["x-entity", "x-tenant"])
		/* Health, logout, register, the sign-in RPCs (token, login, refresh, revoke), the styles read, the
		 * search QUERY and the untagged account update: none is a resource. */
		expect(facts.gapsByTag.get("x-entity")).toHaveLength(10)
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

describe("doctorFacts and the roots a config supplies", () => {
	it("stops blocking on a root once the config supplies it", async () => {
		const { model } = await referenceModel()
		const principals = { alpha: { scope: { project_id: "proj_alpha" } }, beta: { scope: { project_id: "proj_beta" } } }
		const facts = doctorFacts(model, { credentials: { principals, security: {} } })
		expect(facts.roots).toEqual({
			required: [],
			supplied: [{ by: "principal scope", root: "project_id" }],
			/* Ids a flow yields (an invite's token and grant, a notice, a minted key) never block. */
			unmade: ["grant_id", "id", "token"],
		})
		const unscoped = doctorFacts(model, { credentials: { principals: { alpha: {}, beta: {} }, security: {} } })
		expect(facts.blocking).toBe(unscoped.blocking - 1)
	})
})
