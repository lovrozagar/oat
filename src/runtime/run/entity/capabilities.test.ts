import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import { contextOf, entityRunOf, notesApi, notesDoc, optionsFor, secured } from "../__fixtures__/api.ts"
import { queryOf } from "./capabilities.ts"

/*
 * What the entity's list can query, from the tag, then config, then the hook: the checks read the
 * list's query narrowed to what was resolved.
 */

/** The notes document, its list tagged with what it can query. */
function queried(): OpenApiDocument {
	const doc = structuredClone(notesDoc()) as unknown as {
		paths: Record<string, Record<string, Record<string, unknown>>>
	}
	const listed = doc.paths["/notes"]?.["get"]
	if (listed !== undefined) listed["x-query"] = { filterable: ["title"], sortable: ["title"] }
	return doc as unknown as OpenApiDocument
}

describe("queryOf", () => {
	it("narrows the list's query to the capabilities it resolved", async () => {
		const ctx = await contextOf(optionsFor(notesApi(queried())))
		const { capabilities, query } = await queryOf(entityRunOf(ctx), {})
		expect(query?.filterable).toEqual(["title"])
		expect(query?.filterable).toEqual(capabilities.filterable.map((field) => field.field))
		expect(query?.sortable).toEqual(capabilities.sortable.map((field) => field.field))
		expect(query?.searchable).toEqual(capabilities.searchable)
	})

	it("takes the global and the entity's configured query, and asks the hook", async () => {
		const asked: string[] = []
		const ctx = await contextOf(
			optionsFor(notesApi(queried()), {
				entities: { note: { query: { sortable: [{ field: "id" }] } } } as never,
				hooks: {
					resolveQueryCapabilities: async (request) => {
						asked.push(request.entity)
						return null
					},
				},
				query: { searchable: ["title"] } as never,
			}),
		)
		const { capabilities } = await queryOf(entityRunOf(ctx), {})
		expect(asked).toEqual(["note"])
		expect(capabilities.sortable.map((field) => field.field)).toContain("id")
		expect(capabilities.searchable).toContain("title")
	})

	it("is no query for a list that returns no collection", async () => {
		const doc = secured({
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/notes": {
					get: {
						operationId: "notes.list",
						responses: {
							"200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" },
						},
						"x-entity": { action: "list", name: "note" },
					},
				},
			},
		}) as unknown as OpenApiDocument
		const ctx = await contextOf(
			optionsFor((_, path) => (path === "/openapi.json" ? { body: doc, status: 200 } : { body: {}, status: 200 })),
		)
		expect((await queryOf(entityRunOf(ctx), {})).query).toBeNull()
	})
})
