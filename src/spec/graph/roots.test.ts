import { describe, expect, it } from "vitest"
import { operation } from "./__fixtures__/operations.ts"
import { entityNamed } from "./entities.ts"
import {
	collectRoots,
	impliedEntityName,
	owningEntityName,
	owningEntityOf,
	prefixRoots,
	scopingParams,
} from "./roots.ts"
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
	it("singularizes the segment before the parameter, unless it is another parameter", () => {
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

/** A table operation at `path`, its path parameters read from it. */
const op = (operationId: string, path: string, more: Partial<OperationModel> = {}) =>
	operation({
		entity: "table",
		operationId,
		path,
		pathParams: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string),
		...more,
	})

describe("scopingParams and prefixRoots", () => {
	const entities = new Map<string, EntityModel>()
	Object.assign(entityNamed(entities, "table"), { create: "table.create", list: "table.list" })
	const operations = [
		op("table.list", "/projects/{project_id}/tables"),
		op("table.create", "/projects/{project_id}/tables"),
		op("table.get", "/projects/{project_id}/tables/{table_id}"),
		op("invite.accept", "/invites/{token}/accept"),
		op("grant.revoke", "/grants/{grant_id}"),
		op("tagged.get", "/orgs/{org_id}", { rootParams: ["org_id"] }),
	]

	it("is a parameter a route hangs below: tagged x-root, followed by another, or by its entity's collection", () => {
		const model = { entities, operations }
		expect(operations.map((one) => scopingParams(one, model))).toEqual([
			["project_id"],
			["project_id"],
			["project_id"],
			[],
			[],
			["org_id"],
		])
	})

	it("maps each prefix root to the operations it scopes, an id a route ends or acts on being none", () => {
		expect(prefixRoots({ entities, operations })).toEqual(
			new Map([
				["project_id", ["table.list", "table.create", "table.get"]],
				["org_id", ["tagged.get"]],
			]),
		)
	})
})
