import { describe, expect, it } from "vitest"
import { testableEntities, untestableEntityReason } from "../../runtime/scope/entities.ts"
import { documentOf, listOp, modelOf, readOp, referenceModel } from "./__fixtures__/models.ts"
import { doctorFacts } from "./doctor-facts.ts"

describe("doctorFacts and the operations a recipe names", () => {
	it("keeps an entity whose operations a security recipe calls when its create answers an id", async () => {
		const { model } = await referenceModel()
		const authCreates = Object.assign(new Set(["apiKey.create", "apiKey.revoke"]), {
			mints: new Set(["apiKey.create"]),
		})
		const facts = doctorFacts(model, { authCreates })
		expect(facts.entities.map((entity) => entity.name)).toContain("api-key")
		expect([facts.entities.length, facts.testable.length, facts.blocking]).toEqual([8, 8, 1])
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
			"webhook",
		])
		expect(facts.trackable).toHaveLength(8)
		expect(facts.testable).toHaveLength(8)
		expect(facts.listable.map((entity) => entity.name)).toEqual(["job", "notice", "row", "table"])
		expect(facts.blocking).toBe(1)
		expect(facts.uniqueConstraints).toEqual([{ entity: "table", unique: [["name"]] }])
		expect(facts.inviting.map((entity) => entity.name)).toEqual(["table"])
		expect(facts.featureGates).toEqual([])
		expect([...facts.gapsByTag.keys()].sort()).toEqual(["x-entity", "x-tenant"])
		/* Health, logout, the sign-in RPCs (token, login, refresh, revoke), the styles read, the search
		 * QUERY and the untagged account update: none is a resource. */
		expect(facts.gapsByTag.get("x-entity")).toHaveLength(9)
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
		expect(facts.testable.length).toBeLessThan(facts.entities.length)
		expect(facts.blocking).toBe(facts.untestable.length)
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

describe("doctorFacts and a run agree on what is testable", () => {
	const record = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
	const create = (entity: string) => ({
		operationId: `${entity}.create`,
		requestBody: {
			content: { "application/json": { schema: { properties: { name: { type: "string" } }, type: "object" } } },
		},
		responses: { "201": { content: { "application/json": { schema: record } }, description: "made" } },
		"x-entity": { action: "create", identity: "id", name: entity },
	})
	/* A list entity, an entity with only its item read, and one with neither a list nor a read. */
	const { model } = modelOf(
		documentOf({
			"/listed": { get: listOp("listed", "listed.list"), post: create("listed") },
			"/listed/{id}": { get: readOp("listed", "listed.get") },
			"/item": { post: create("item") },
			"/item/{id}": { get: readOp("item", "item.get") },
			"/bare": { post: create("bare") },
		}),
	)
	const none = new Set<string>()

	it("counts testable, untestable and blocking by the run's own answer, with its reasons", () => {
		const facts = doctorFacts(model)
		const run = testableEntities(model, none).map((entity) => entity.name)
		expect(run).toEqual(["item", "listed"])
		expect(facts.testable.map((entity) => entity.name)).toEqual(run)
		expect(facts.untestable).toEqual(
			[...model.entities.values()]
				.filter((entity) => !run.includes(entity.name))
				.map((entity) => ({ entity: entity.name, reason: untestableEntityReason(entity, model, none) })),
		)
		expect(facts.untestable).toEqual([{ entity: "bare", reason: '"bare" has no list operation and no read operation' }])
		expect(facts.blocking).toBe(1)
	})
})

describe("doctorFacts and the cache bypass", () => {
	const doc = documentOf({
		"/notes": { get: listOp("note", "notes.list") },
		"/notes/{id}": {
			get: readOp("note", "notes.get", { "x-consistency": { bypass: "x-fresh: 1", staleness: "30s" } }),
		},
		"/tags/{id}": { get: readOp("tag", "tags.get", { "x-consistency": { bypass: "x-fresh: 1" } }) },
	})

	it("groups the reads by the bypass oat sends them: declared, else the default no-cache", () => {
		expect(doctorFacts(modelOf(doc).model).bypass).toEqual([
			{ bypass: "x-fresh: 1", operations: ["notes.get", "tags.get"], source: "declared" },
			{ bypass: "cache-control: no-cache", operations: ["notes.list"], source: "default" },
		])
	})

	it("is one group sending none when the config turns the bypass off", () => {
		expect(doctorFacts(modelOf(doc).model, { cacheBypass: false }).bypass).toEqual([
			{ bypass: null, operations: ["notes.get", "notes.list", "tags.get"], source: "off" },
		])
	})
})
