import { describe, expect, it } from "vitest"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

const member = { properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"], type: "object" }
const ok = (schema: unknown) => ({ "200": { content: { "application/json": { schema } }, description: "ok" } })
const collection = (parent: string, param: string) => ({
	[`/v1/${parent}/{${param}}/members`]: {
		get: { operationId: `${parent}.members.list`, responses: ok({ items: member, type: "array" }) },
		post: { operationId: `${parent}.members.create`, responses: ok(member) },
	},
	[`/v1/${parent}/{${param}}/members/{member_id}`]: {
		get: { operationId: `${parent}.members.get`, responses: ok(member) },
	},
})

describe("model derivation", () => {
	it("keeps same-named collections under different parents apart", () => {
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: { ...collection("projects", "project_id"), ...collection("orgs", "org_id") },
		} as OpenApiDocument
		const model = buildModel(dereference(doc).doc)
		expect([...model.entities.keys()].sort()).toEqual(["org-member", "project-member"])
		expect(model.entities.get("project-member")?.list).toBe("projects.members.list")
		expect(model.entities.get("org-member")?.create).toBe("orgs.members.create")
	})

	it("names a split collection by its final name when it reports a gap", () => {
		const views = (parent: string, param: string) => ({
			[`/v1/${parent}/{${param}}/members`]: {
				get: { operationId: `${parent}.members.list`, responses: ok({ items: member, type: "array" }) },
			},
		})
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: { ...views("projects", "project_id"), ...views("orgs", "org_id") },
		} as OpenApiDocument
		const details = buildModel(dereference(doc).doc)
			.gaps.gaps.filter((gap) => gap.tag === "x-entity")
			.map((gap) => gap.detail)
		expect(details.some((detail) => detail.includes('treats "org-member" as its own entity'))).toBe(true)
		expect(details.some((detail) => detail.includes('treats "member"'))).toBe(false)
	})

	it("leaves a name alone when only one collection carries it", () => {
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: collection("projects", "project_id"),
		} as OpenApiDocument
		expect([...buildModel(dereference(doc).doc).entities.keys()]).toEqual(["member"])
	})
})

describe("create per noun", () => {
	it("keeps the create of a collection that has no item route", () => {
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/notes": {
					get: { operationId: "notes.list", responses: ok({ items: member, type: "array" }) },
					post: { operationId: "notes.create", responses: ok(member) },
				},
				"/v1/ping": { post: { operationId: "ping", responses: ok({ type: "object" }) } },
			},
		} as OpenApiDocument
		const model = buildModel(dereference(doc).doc)
		expect(model.entities.get("note")?.create).toBe("notes.create")
		expect(model.gaps.gaps.some((gap) => gap.operationId === "ping" && gap.tag === "x-entity")).toBe(true)
	})
})

describe("duplicate operation ids", () => {
	it("keep the first and report the second", () => {
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/notes": { get: { operationId: "same", responses: ok({ items: member, type: "array" }) } },
				"/v1/tags": { get: { operationId: "same", responses: ok({ items: member, type: "array" }) } },
			},
		} as OpenApiDocument
		const model = buildModel(dereference(doc).doc)
		expect(model.byOperationId.get("same")?.path).toBe("/v1/notes")
		expect(model.gaps.gaps.find((gap) => gap.tag === "operationId")?.detail).toContain("GET /v1/tags")
	})
})

describe("collections and identities behind composition", () => {
	it("finds the collection through allOf and a nullable array", async () => {
		const { deriveCollectionShape, deriveIdentity } = await import("../src/spec/collection.ts")
		const shape = deriveCollectionShape({
			allOf: [
				{ properties: { total: { type: "integer" } }, type: "object" },
				{ properties: { rows: { items: { allOf: [member] }, type: ["array", "null"] } }, type: "object" },
			],
		})
		expect(shape?.key).toBe("rows")
		expect(shape?.pagination.countKey).toBe("total")
		expect(deriveIdentity(shape?.itemSchema ?? null)).toBe("id")
		expect(deriveIdentity({ anyOf: [{ type: "null" }, member] })).toBe("id")
	})

	it("reads the identity off a camelCase path parameter", async () => {
		const { deriveIdentity } = await import("../src/spec/collection.ts")
		expect(deriveIdentity(null, "tableId")).toBe("id")
		expect(deriveIdentity(null, "table_id")).toBe("id")
		expect(deriveIdentity(null, "workspaceUuid")).toBe("uuid")
	})
})

describe("tag validation", () => {
	it("reports a malformed tag and reads a malformed x-destructive as destructive", () => {
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/notes/{note_id}": {
					delete: {
						operationId: "notes.delete",
						responses: { "204": { description: "gone" } },
						"x-cost": "huge",
						"x-destructive": "yes",
						"x-invalidate": ["/v1/notes"],
					},
				},
			},
		} as unknown as OpenApiDocument
		const model = buildModel(dereference(doc).doc)
		const details = model.gaps.gaps.map((gap) => gap.detail)
		expect(details).toContain("x-destructive must be true or false; oat cannot use it")
		expect(details.some((detail) => detail.startsWith("x-cost must be one of"))).toBe(true)
		expect(details.some((detail) => detail.startsWith("x-invalidate must be an array of routes"))).toBe(true)
		expect(model.byOperationId.get("notes.delete")?.destructive).toBe(true)
	})

	it("checks x-query field by field, and accepts a well-formed one", () => {
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
