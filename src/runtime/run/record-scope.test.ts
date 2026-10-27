import { describe, expect, it } from "vitest"
import type { EntityModel } from "../../spec/graph/types.ts"
import { recordScope } from "./record-scope.ts"

const entities = new Map([["key", { identity: "key_ref" } as EntityModel]])
const model = { entities }
const revoke = { entity: "key", pathParams: ["project_id", "api_key_id"] }

describe("recordScope", () => {
	it("binds the last path parameter to the record's identity: the entity's own field, else `id`", () => {
		expect(recordScope(model, revoke, { key_ref: "r1", project_id: "p1" })).toEqual({
			api_key_id: "r1",
			key_ref: "r1",
			project_id: "p1",
		})
		expect(recordScope(model, { entity: null, pathParams: ["api_key_id"] }, { id: "7" })).toEqual({
			api_key_id: "7",
			id: "7",
		})
		expect(recordScope(model, revoke, { id: "7" })).toEqual({ api_key_id: "7", id: "7" })
	})

	it("keeps a parameter bound by name, and binds nothing it has no identity for or no parameter to take it", () => {
		expect(recordScope(model, revoke, { api_key_id: "a", id: "7" })).toEqual({ api_key_id: "a", id: "7" })
		expect(recordScope(model, revoke, { project_id: "p1" })).toEqual({ project_id: "p1" })
		expect(recordScope(model, { entity: "key", pathParams: [] }, { id: "7" })).toEqual({ id: "7" })
	})
})
