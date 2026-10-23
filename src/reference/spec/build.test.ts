import { describe, expect, it } from "vitest"
import { LINKED, POSTGREST } from "../dialect/presets.ts"
import { ENTITIES } from "../model/entities.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { shapedEntities } from "../model/shaped.ts"
import { TABLE } from "../model/table.ts"
import { buildSpec, buildUntaggedSpec } from "./build.ts"
import type { Json } from "./types.ts"

function keysDeep(node: unknown, found = new Set<string>()): Set<string> {
	if (Array.isArray(node)) {
		for (const child of node) keysDeep(child, found)
	} else if (node !== null && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			found.add(key)
			keysDeep(value, found)
		}
	}
	return found
}

describe("buildSpec", () => {
	const spec = buildSpec()

	it("is the PostgREST document over the default entities when called bare", () => {
		expect(spec).toEqual(buildSpec(POSTGREST, { entities: ENTITIES, shape: {} }))
		/* 3.2: the search route is a QUERY operation, a Path Item field since OAS 3.2. */
		expect(spec).toMatchObject({ info: { title: "oat reference backend", version: "1.0.0" }, openapi: "3.2.0" })
	})

	it("routes every entity, then the caller, public, invite, job, auth, API key, styles and search routes", () => {
		const routes = Object.keys(spec["paths"] as Json)
		expect(routes.slice(0, 6)).toEqual([TABLE, ROW, JOB].flatMap((entity) => [entity.collectionPath, entity.itemPath]))
		expect(routes.slice(6)).toEqual([
			"/v1/me",
			"/health",
			"/v1/notices",
			"/v1/notices/{id}",
			"/v1/logout",
			"/v1/projects/{project_id}/overview",
			"/v1/register",
			`${TABLE.itemPath}/invites`,
			"/v1/invites/{token}/accept",
			`${TABLE.itemPath}/grants/{grant_id}`,
			`${JOB.collectionPath}/start`,
			"/v1/projects/{project_id}/notifications",
			"/v1/projects/{project_id}/inbox",
			"/v1/auth/token",
			"/v1/auth/login",
			"/v1/auth/refresh",
			"/v1/auth/revoke",
			"/v1/api-keys",
			"/v1/api-keys/{id}",
			"/v1/styles",
			"/v1/search",
		])
	})
})

describe("buildSpec security", () => {
	const spec = buildSpec()

	it("declares jwt auth at the root, and leaves how to obtain it to the config's recipe", () => {
		expect(Object.keys(spec)).toEqual(["info", "openapi", "paths", "components", "security"])
		expect(spec["security"]).toEqual([{ jwt: [] }])
		expect(spec).not.toHaveProperty("x-auth-flows")
	})

	it("lets each record operation take a jwt or an API key scoped to its entity and access", () => {
		const paths = spec["paths"] as Record<string, Record<string, Json>>
		expect(paths[TABLE.collectionPath]?.["get"]?.["security"]).toEqual([{ jwt: [] }, { apiKey: ["table:read"] }])
		expect(paths[ROW.collectionPath]?.["post"]?.["security"]).toEqual([{ jwt: [] }, { apiKey: ["row:write"] }])
		expect(paths[JOB.itemPath]?.["delete"]?.["security"]).toEqual([{ jwt: [] }, { apiKey: ["job:write"] }])
		expect(paths["/v1/me"]?.["get"]).not.toHaveProperty("security")
		expect(paths["/health"]?.["get"]?.["security"]).toEqual([])
	})

	it("marks the table's verified flag x-privileged", () => {
		const table = (spec["paths"] as Record<string, Record<string, Json>>)[TABLE.itemPath]?.["get"]
		expect(table).toHaveProperty("responses.200.content.application/json.schema.properties.verified", {
			type: "boolean",
			"x-privileged": true,
		})
	})
})

describe("buildSpec dialects and layout", () => {
	it("follows the dialect it is given", () => {
		const linked = buildSpec(LINKED)
		expect(linked).toHaveProperty(["paths", TABLE.collectionPath, "get", "responses", "200", "headers", "Link"])
	})

	it("puts components first and hoists path parameters under the layout shape", () => {
		const shape = { specLayout: true }
		const laid = buildSpec(POSTGREST, { entities: shapedEntities(shape), shape })
		expect(Object.keys(laid)).toEqual(["info", "openapi", "components", "paths", "security"])
		const item = (laid["paths"] as Record<string, Json>)[TABLE.itemPath] as { parameters: Json[]; get: Json }
		expect(item.parameters.map((param) => param["name"])).toEqual(["project_id", "table_id"])
		expect(item.get["parameters"]).toEqual([])
	})
})

describe("buildUntaggedSpec", () => {
	it("strips every oat meta tag except the root marker", () => {
		const untagged = buildUntaggedSpec()
		const keys = [...keysDeep(untagged)]
		expect(keys.filter((key) => key.startsWith("x-"))).toEqual(["x-root"])
		expect(keysDeep(buildSpec()).has("x-query")).toBe(true)
	})

	it("keeps everything else, nulls and arrays included", () => {
		const untagged = buildUntaggedSpec(POSTGREST, { entities: ENTITIES, shape: {} })
		expect(untagged["paths"]).toHaveProperty([TABLE.collectionPath, "get", "operationId"], "table.list")
		expect(untagged["security"]).toEqual([{ jwt: [] }])
		expect(untagged).not.toHaveProperty("x-auth-flows")
	})
})
