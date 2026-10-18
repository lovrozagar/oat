import { describe, expect, it } from "vitest"
import { operation } from "./__fixtures__/operations.ts"
import { entityNamed } from "./entities.ts"
import { collectRoots, impliedEntityName, owningEntityName, owningEntityOf } from "./roots.ts"
import type { EntityModel, OperationModel } from "./types.ts"

const at = (method: string, path: string, entity: string | null) => ({ entity, method, path })

describe("collectRoots", () => {
	it("is every declared root and every parameter nothing in the document can create, sorted", () => {
		const entities = new Map<string, EntityModel>()
		Object.assign(entityNamed(entities, "project"), { create: "projects.create" })
		Object.assign(entityNamed(entities, "team"), { invite: {} })
		entityNamed(entities, "org")
		const operations: OperationModel[] = [
			operation({
				entity: null,
				path: "/orgs/{org_id}/projects/{project_id}",
				pathParams: ["org_id", "project_id"],
				rootParams: ["z"],
			}),
			operation({ entity: null, path: "/teams/{team_id}/{id}", pathParams: ["team_id", "id"] }),
			operation({ entity: null, path: "/{workspace}", pathParams: ["workspace"] }),
			operation({ entity: null, path: "/a/{tenant_key}", pathParams: ["tenant_key"] }),
		]
		expect(collectRoots(operations, entities)).toEqual(["org_id", "tenant_key", "workspace", "z"])
	})
})

describe("owningEntityOf", () => {
	it("is what the document tags the collection's create as, else its item read, else the segment", () => {
		const operations = [
			at("POST", "/v1/hooks", "org-hook"),
			at("GET", "/v1/items/{x}", "thing"),
			at("POST", "/v1/untagged", null),
		]
		expect(owningEntityOf(operations, "/v1/hooks/{hook_id}", "hook_id")).toBe("org-hook")
		expect(owningEntityOf(operations, "/v1/items/{item_id}", "item_id")).toBe("thing")
		expect(owningEntityOf(operations, "/v1/untagged/{id}", "id")).toBe("untagged")
	})

	it("is null for a parameter at the start of the path or not in it", () => {
		expect(owningEntityOf([], "/{id}/rows", "id")).toBeNull()
		expect(owningEntityOf([], "/rows", "id")).toBeNull()
	})
})

describe("owningEntityName", () => {
	it("singularises the segment before the parameter, unless it is another parameter", () => {
		expect(owningEntityName("/projects/{project_id}", "project_id")).toBe("project")
		expect(owningEntityName("/a/{x}/{y}", "y")).toBeNull()
		expect(owningEntityName("/{y}", "y")).toBeNull()
	})
})

describe("impliedEntityName", () => {
	it("reads the entity off the parameter's name", () => {
		expect(impliedEntityName("project_id")).toBe("project")
		expect(impliedEntityName("tableId")).toBe("table")
		expect(impliedEntityName("orgMemberSlug")).toBe("org-member")
		expect(impliedEntityName("id")).toBeNull()
	})
})
