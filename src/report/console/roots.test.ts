import { describe, expect, it } from "vitest"
import type { SpecModel } from "../../spec/graph/types.ts"
import { referenceModel } from "./__fixtures__/models.ts"
import { rootsOf } from "./roots.ts"

/* A root no create operation makes is the config's to supply: by every principal's scope, a login claim, or a hook. */

const op = (operationId: string, path: string, rootParams: string[] = []) => ({
	entity: null,
	operationId,
	path,
	pathParams: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
	rootParams,
})
const MODEL = {
	operations: [
		op("table.list", "/orgs/{org_id}/projects/{project_id}/tables", ["org_id"]),
		op("row.get", "/projects/{project_id}/rows/{row_id}"),
		op("invite.accept", "/invites/{token}/accept"),
	],
	entities: new Map(),
	roots: ["org_id", "project_id", "token"],
} as unknown as Pick<SpecModel, "operations" | "entities" | "roots">

describe("rootsOf", () => {
	it("calls every prefix root required when no config is read, and an id no operation makes unmade", () => {
		expect(rootsOf(MODEL)).toEqual({ required: ["org_id", "project_id"], supplied: [], unmade: ["token"] })
	})

	it("calls a root supplied when every principal's scope binds it, and required while one does not", () => {
		const principals = { alpha: { scope: { project_id: "p1" } }, beta: { scope: { project_id: "p2" } } }
		expect(rootsOf(MODEL, { credentials: { principals, security: {} } })).toEqual({
			required: ["org_id"],
			supplied: [{ by: "principal scope", root: "project_id" }],
			unmade: ["token"],
		})
		const partly = { alpha: { scope: { project_id: "p1" } }, beta: {} }
		expect(rootsOf(MODEL, { credentials: { principals: partly, security: {} } }).required).toEqual([
			"org_id",
			"project_id",
		])
		expect(rootsOf(MODEL, { credentials: { principals: {}, security: {} } }).required).toEqual(["org_id", "project_id"])
	})

	it("calls a root supplied when a login binds it from its answer, or a hook resolves path values", () => {
		const login = { claims: { "scope.org_id": "$.org.id", tenant: "org" }, from: "$.t", steps: [] }
		const security = { jwt: { login }, key: { static: "k" } } as never
		expect(rootsOf(MODEL, { credentials: { principals: { alpha: {} }, security } })).toEqual({
			required: ["project_id"],
			supplied: [{ by: "login claims (jwt)", root: "org_id" }],
			unmade: ["token"],
		})
		const hooks = { resolvePathValue: async () => null }
		expect(rootsOf(MODEL, { hooks })).toEqual({
			required: [],
			supplied: MODEL.roots.map((root) => ({ by: "hooks.resolvePathValue", root })),
			unmade: [],
		})
	})
})

describe("rootsOf on the reference", () => {
	it("finds the project root by structure alone when no x-root tag says so, and ids a flow yields as unmade", async () => {
		for (const untagged of [false, true]) {
			const { model } = await referenceModel({ untagged })
			const roots = rootsOf(model)
			expect(roots.required).toEqual(["project_id"])
			expect(roots.unmade).toEqual(expect.arrayContaining(["grant_id", "token"]))
		}
	})
})
