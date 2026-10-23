import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import { runCheck } from "../../checks/core/run.ts"
import { zeroMatchFilter } from "../../checks/families/filter/filter-zero-match-returns-none.ts"
import { contextOf, entityRunOf, notesApi, notesDoc, optionsFor, secured } from "../__fixtures__/api.ts"
import { queryOf } from "./capabilities.ts"
import { checkContext } from "./check-context.ts"

/*
 * What the entity's list can query, from the tag, then config, then the hook: the checks read the
 * list's query narrowed to what was resolved.
 */

/** The notes document, its list declaring `parameters` and, unless `null`, tagged with `tag`. */
function queried(
	parameters: string[] = ["sort"],
	tag: Record<string, unknown> | null = { filterable: ["title"], sortable: ["title"] },
): OpenApiDocument {
	const doc = structuredClone(notesDoc()) as unknown as {
		paths: Record<string, Record<string, Record<string, unknown>>>
	}
	const listed = doc.paths["/notes"]?.["get"]
	if (listed !== undefined) {
		listed["parameters"] = parameters.map((name) => ({ in: "query", name, schema: { type: "string" } }))
		if (tag !== null) listed["x-query"] = tag
	}
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
			optionsFor(notesApi(queried(["sort", "q"])), {
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

describe("queryOf with no list", () => {
	it("has nothing to query and asks nothing", async () => {
		const options = optionsFor(notesApi())
		const ctx = await contextOf(options)
		const before = options.seen.length
		const run = { ...entityRunOf(ctx), listOp: undefined }
		const { capabilities, query, withheld } = await queryOf(run, {})
		expect(query).toBeNull()
		expect([capabilities.filterable, capabilities.sortable, capabilities.searchable]).toEqual([[], [], []])
		expect(withheld).toEqual([])
		expect(options.seen.length).toBe(before)
	})
})

describe("queryOf and the parameters the list declares", () => {
	it("withholds what no declared parameter carries, and keeps what one does", async () => {
		const ctx = await contextOf(optionsFor(notesApi(queried([]))))
		const { capabilities, query, withheld } = await queryOf(entityRunOf(ctx), {})
		expect(capabilities.filterable.map((field) => field.field)).toEqual(["title"])
		expect(capabilities.sortable).toEqual([])
		expect(query?.sortable).toEqual([])
		expect(withheld).toEqual([{ axis: "sortable", row: { field: "title", type: "string" } }])
	})

	it("cuts the guessed per-field filters to the parameters the list declares", async () => {
		/* No `x-query`: a free-text `q` makes oat guess every scalar filterable, one parameter each. */
		const ctx = await contextOf(optionsFor(notesApi(queried(["q", "title"], null))))
		const { capabilities, withheld } = await queryOf(entityRunOf(ctx), {})
		expect(capabilities.filterable.map((field) => field.field)).toEqual(["title"])
		expect(withheld).toContainEqual({ axis: "filterable", row: { field: "id", type: "string" } })
	})
})

describe("a filter probe and the parameters the list declares", () => {
	const world = {
		createAcknowledged: false,
		degraded: false,
		records: [{ id: "n1", title: "one" }],
		scope: { created: [], values: {} },
		uniqueAdopted: false,
	}
	const actor = { id: "alpha", inviteAs: undefined, rank: 0, scope: {}, tenant: "t" }

	async function probe(parameters: string[]) {
		const options = optionsFor(notesApi(queried(parameters, null), [{ id: "n1", title: "one" }]))
		const ctx = await contextOf(options)
		const checks = await checkContext(entityRunOf(ctx), world, [actor])
		const outcome = await runCheck(zeroMatchFilter, checks)
		return { outcome, sent: options.seen.filter((seen) => seen.path === "/notes").map((seen) => seen.query) }
	}

	it("sends no `?id=` to a list that declares no `id` parameter, and stands down naming it", async () => {
		const { outcome, sent } = await probe(["q"])
		expect(outcome).toEqual({
			kind: "stood-down",
			reason: "the `id` query parameter, which the list operation does not declare",
		})
		expect(sent.some((query) => "id" in query)).toBe(false)
	})

	it("still probes a list that declares its `id` parameter", async () => {
		const { outcome, sent } = await probe(["q", "id"])
		expect(outcome.kind).not.toBe("stood-down")
		expect(sent.some((query) => "id" in query)).toBe(true)
	})
})
