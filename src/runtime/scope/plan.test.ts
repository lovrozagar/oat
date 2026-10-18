import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { referenceModel } from "./__fixtures__/models.ts"
import { describeRequested, planScope } from "./plan.ts"
import { resolveTargetScope } from "./target.ts"

describe("planning a scope without a network", () => {
	it("says what was asked, as typed", () => {
		expect(describeRequested({ only: ["row"], ops: ["table.get", "table.list"] })).toBe(
			"--ops table.get,table.list --only row",
		)
		expect(describeRequested({ only: ["row"], ops: [] })).toBe("--only row")
		expect(describeRequested({ only: [], ops: [] })).toBe("")
	})

	it("names each target's grading checks and the entities a targeted run queues", () => {
		const model = referenceModel()
		const plan = planScope(model, resolveTargetScope(model, { ops: ["table.get", "auth.token"] }))
		expect(plan.mode).toBe("targeted")
		expect(plan.targets.map((target) => target.operationId)).toEqual(["table.get"])
		expect(plan.targets[0]?.checks.length).toBeGreaterThan(0)
		expect(plan.entities).toContain("table")
		expect(plan.untestable).toEqual([{ operationId: "auth.token", reason: expect.stringMatching(/^unmodeled:/) }])
		/* A target is not support, even when the plan would call it anyway. */
		expect(plan.support).not.toContain("table.get")
		expect(plan.support).toContain("row.create")
	})
})

describe("planning a full run", () => {
	it("plans every graded operation in a full run, with the parents creates need as support", () => {
		const model = referenceModel()
		const plan = planScope(model, resolveTargetScope(model, {}))
		expect(plan.mode).toBe("full")
		expect(plan.targets.map((target) => target.operationId)).toContain("row.create")
		expect(plan.targets.find((target) => target.operationId === "row.create")?.entity).toBe("row")
		expect(plan.support).toEqual(expect.arrayContaining(["table.create", "row.create", "profile.get"]))
		expect(plan.origins).toEqual({})
	})

	it("needs no parent for a path parameter no entity owns", () => {
		const note = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
		const tenant = [{ in: "path", name: "tenant", required: true, schema: { type: "string" } }]
		const model = buildModel({
			info: { title: "tenant", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/{tenant}/notes": {
					get: {
						operationId: "note.list",
						parameters: tenant,
						responses: {
							"200": { content: { "application/json": { schema: { items: note, type: "array" } } }, description: "ok" },
						},
					},
					post: {
						operationId: "note.create",
						parameters: tenant,
						requestBody: { content: { "application/json": { schema: note } } },
						responses: { "201": { content: { "application/json": { schema: note } }, description: "ok" } },
					},
				},
			},
		} as unknown as OpenApiDocument)
		expect(planScope(model, resolveTargetScope(model, {})).support).toEqual(["note.create", "note.list"])
	})

	it("lists origins with their targets", () => {
		const model = referenceModel()
		const plan = planScope(
			model,
			resolveTargetScope(model, { ops: ["cdn:row.get"], origins: new Map([["cdn", referenceModel()]]) }),
		)
		expect(plan.origins).toEqual({ cdn: ["row.get"] })
		expect(plan.targets).toEqual([])
	})
})
