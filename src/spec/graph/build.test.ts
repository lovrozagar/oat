import { describe, expect, it } from "vitest"
import { doc, list, member, ok } from "../__fixtures__/documents.ts"
import { dereference } from "../load/dereference.ts"
import { anyrow } from "../security/__fixtures__/documents.ts"
import type { OpenApiDocument } from "../types.ts"
import { modelOf } from "./__fixtures__/operations.ts"
import { buildModel } from "./build.ts"

const listing = (xQuery: Record<string, unknown>) =>
	({
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/notes": {
				get: { operationId: "notes.list", responses: { "200": { description: "ok" } }, "x-query": xQuery },
			},
		},
	}) as unknown as OpenApiDocument

const gapsFor = (xQuery: Record<string, unknown>) =>
	buildModel(dereference(listing(xQuery)).doc)
		.gaps.gaps.filter((gap) => gap.tag === "x-query")
		.map((gap) => gap.detail)

describe("buildModel", () => {
	it("indexes operations by id and route, keeps the raw operations, and lists the roots", () => {
		const model = modelOf(
			{
				"/v1/auth/login": { post: { operationId: "auth.login", responses: ok({ type: "object" }) } },
				"/orgs/{org_id}/notes": {
					get: { operationId: "notes.list", responses: ok(list(member)) },
					post: { operationId: "notes.create", responses: ok(member) },
				},
				"/orgs/{org_id}/notes/{note_id}": { get: { operationId: "notes.get", responses: ok(member) } },
			},
			{ components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } } },
		)
		expect([...model.byRoute.keys()]).toEqual([
			"POST /v1/auth/login",
			"GET /orgs/{org_id}/notes",
			"POST /orgs/{org_id}/notes",
			"GET /orgs/{org_id}/notes/{note_id}",
		])
		expect(model.byOperationId.get("notes.get")?.route).toBe("GET /orgs/{org_id}/notes/{note_id}")
		expect(model.rawOperations.get("notes.list")?.operationId).toBe("notes.list")
		expect(model.roots).toEqual(["org_id"])
		expect(model.hasAuthOperations).toBe(true)
		expect(model.securitySchemes).toEqual(["jwt"])
		expect(model.entities.get("note")).toMatchObject({ create: "notes.create", readSurface: expect.any(Array) })
		expect(model.defs).toEqual({})
	})

	it("carries the recursive schemas, and no auth or schemes where the document has none", () => {
		const recursive = { properties: { child: { $ref: "#/components/schemas/Node" } }, type: "object" }
		const model = buildModel(
			dereference(
				doc(
					{ "/nodes": { get: { operationId: "nodes.get", responses: ok({ $ref: "#/components/schemas/Node" }) } } },
					{ components: { schemas: { Node: recursive } } },
				),
			).doc,
		)
		expect(Object.keys(model.defs)).toEqual(["Node"])
		expect(model.hasAuthOperations).toBe(false)
		expect(model.securitySchemes).toEqual([])
	})
})

describe("create per noun", () => {
	it("keeps the create of a collection that has no item route", () => {
		const model = modelOf({
			"/v1/notes": {
				get: { operationId: "notes.list", responses: ok(list(member)) },
				post: { operationId: "notes.create", responses: ok(member) },
			},
			"/v1/ping": { post: { operationId: "ping", responses: ok({ type: "object" }) } },
		})
		expect(model.entities.get("note")?.create).toBe("notes.create")
		expect(model.gaps.gaps.some((gap) => gap.operationId === "ping" && gap.tag === "x-entity")).toBe(true)
	})
})

describe("duplicate operation ids", () => {
	it("keep the first and report the second", () => {
		const model = modelOf({
			"/v1/notes": { get: { operationId: "same", responses: ok(list(member)) } },
			"/v1/tags": { get: { operationId: "same", responses: ok(list(member)) } },
		})
		expect(model.byOperationId.get("same")?.path).toBe("/v1/notes")
		expect(model.rawOperations.get("same")?.responses).toBeDefined()
		expect(model.gaps.gaps.find((gap) => gap.tag === "operationId")?.detail).toBe(
			"is declared by both GET /v1/notes and GET /v1/tags; operation ids must be unique, so GET /v1/tags is reachable only by its route",
		)
	})
})

describe("tag validation", () => {
	it("reports a malformed tag and reads a malformed x-destructive as destructive", () => {
		const model = modelOf({
			"/v1/notes/{note_id}": {
				delete: {
					operationId: "notes.delete",
					responses: { "204": { description: "gone" } },
					"x-cost": "huge",
					"x-destructive": "yes",
					"x-invalidate": ["/v1/notes"],
				},
			},
		})
		const found = model.gaps.gaps.map((gap) => gap.detail)
		expect(found).toContain("x-destructive must be true or false; oat cannot use it")
		expect(found.some((detail) => detail.startsWith("x-cost must be one of"))).toBe(true)
		expect(found.some((detail) => detail.startsWith("x-invalidate must be an array of routes"))).toBe(true)
		expect(model.byOperationId.get("notes.delete")?.destructive).toBe(true)
	})

	it("checks x-query field by field, and accepts a well-formed one", () => {
		expect(gapsFor({ grammar: "bogus" })).toEqual([
			'x-query "grammar" must be one of "postgrest", "colon", "equality"; oat cannot use it',
		])
		expect(gapsFor({ filterable: 5 })[0]).toMatch(/"filterable" must be an array/)
		expect(gapsFor({ maxLimit: "x" })[0]).toMatch(/"maxLimit" must be a positive integer/)
		expect(gapsFor({ sortable: [{ type: "date" }] })[0]).toMatch(/"sortable" has a row that needs "field"/)
		expect(
			gapsFor({
				filterable: ["id", { field: "name", ops: ["eq", "like"], type: "string" }],
				filterableFrom: { operationId: "table.get", path: "$.columns[*].name" },
				grammar: "postgrest",
				maxLimit: 100,
				searchable: null,
				sortCollation: "case-insensitive",
			}),
		).toEqual([])
	})
})

describe("security on the model", () => {
	it("carries each operation's resolved requirement and every declared scheme", () => {
		const model = buildModel(anyrow)
		expect(model.byOperationId.get("auth.login")?.security.alternatives).toEqual([[]])
		expect(model.byOperationId.get("row.list")?.security.alternatives).toEqual([
			[{ scheme: "jwt", scopes: [] }],
			[{ scheme: "apiKey", scopes: ["rows:read"] }],
		])
		expect(model.byOperationId.get("row.list")?.securitySchemes).toEqual(["jwt", "apiKey"])
		expect([...model.schemes.keys()].toSorted()).toEqual(["apiKey", "jwt"])
	})
})

describe("x-cleanup routes", () => {
	it("records an operation oat never sends as a gap, and joins it to no entity", () => {
		const model = modelOf({
			"/v1/notes": { get: { operationId: "notes.list", responses: ok(list(member)) } },
			"/v1/notes/{note_id}": {
				get: { operationId: "notes.get", responses: ok(member) },
				trace: { operationId: "notes.trace", responses: ok(member), "x-entity": { action: "read", name: "note" } },
			},
		})
		const trace = model.byOperationId.get("notes.trace")
		expect(trace).toMatchObject({ action: null, entity: null })
		expect(model.entities.get("note")).toMatchObject({ read: "notes.get", reads: ["notes.get"] })
		expect(model.gaps.gaps.filter((gap) => gap.tag === "TRACE")).toEqual([
			{ detail: trace?.unsendable, operationId: "notes.trace", tag: "TRACE" },
		])
	})

	it("reports a cleanup route the document does not have, and not one it has", () => {
		const purge = { post: { operationId: "notes.purge", responses: { "204": { description: "gone" } } } }
		const model = modelOf({
			"/v1/admin/purge": purge,
			"/v1/notes": {
				post: { operationId: "notes.create", responses: ok(member), "x-cleanup": "post /v1/admin/purge" },
			},
			"/v1/tags": {
				post: { operationId: "tags.create", responses: ok(member), "x-cleanup": "DELETE /v1/tags/{tag_id}" },
			},
		})
		expect(model.gaps.gaps.filter((gap) => gap.tag === "x-cleanup")).toEqual([
			{
				detail: 'names "DELETE /v1/tags/{tag_id}", which is not an operation in this document',
				operationId: "tags.create",
				tag: "x-cleanup",
			},
		])
	})
})
