import { describe, expect, it } from "vitest"
import { exchange } from "../__fixtures__/harness.ts"
import { notesContext, notesModel, withConventions } from "../query/__fixtures__/notes.ts"
import { envelopeValue, extractItems, forList, ids, list, type ListResult } from "./list.ts"
import { op } from "../__fixtures__/harness.ts"

/*
 * One page of a list and the facts it carries. A pagination fact is read by whatever the
 * document calls it, from the body or from a declared `Link` header, where a missing `rel="next"`
 * is a definite "no more pages", not an unknown.
 */

const TAGS = {
	"/tags": {
		get: {
			operationId: "tag.list",
			responses: {
				"200": {
					content: {
						"application/json": {
							schema: {
								properties: { data: { items: { properties: { slug: { type: "string" } } }, type: "array" } },
								type: "object",
							},
						},
					},
					description: "ok",
				},
			},
			"x-entity": { action: "list", identity: "slug", name: "tag" },
		},
	},
}

const page = (body: Record<string, unknown>, headers: Record<string, string> = {}): ListResult => ({
	envelope: body,
	exchange: exchange("GET", "/notes", { body, headers, status: 200 }),
	items: [],
})

describe("envelopeValue", () => {
	it("reads a fact from the body under the name the document gives it", () => {
		const ctx = withConventions(notesContext().ctx, { envelope: { hasMore: "more", total: "count" } })
		expect(envelopeValue(ctx, page({ count: 9, more: true }), "total")).toBe(9)
		expect(envelopeValue(ctx, page({ count: 9, more: true }), "hasMore")).toBe(true)
	})

	it("is unknown when neither the body nor a Link header carries it", () => {
		const ctx = notesContext().ctx
		expect(envelopeValue(ctx, page({ total: 9 }), "total")).toBeUndefined()
	})

	it("reads more pages and the next cursor from a declared Link header", () => {
		const ctx = withConventions(notesContext().ctx, { linkHeader: "Link" })
		const linked = page(
			{},
			{ link: '<https://api.test/notes?page=2>; rel="next", <https://api.test/notes?page=1>; rel=first' },
		)
		expect(envelopeValue(ctx, linked, "hasMore")).toBe(true)
		expect(envelopeValue(ctx, linked, "nextCursor")).toBe("https://api.test/notes?page=2")
		expect(envelopeValue(ctx, linked, "total")).toBeUndefined()
		const capitalized = page({}, { Link: '<https://api.test/notes?page=3>; rel="next"' })
		expect(envelopeValue(ctx, capitalized, "nextCursor")).toBe("https://api.test/notes?page=3")
	})

	it("reads a declared Link header's absence, or no next relation, as no more pages", () => {
		const ctx = withConventions(notesContext().ctx, { linkHeader: "Link" })
		expect(envelopeValue(ctx, page({}), "hasMore")).toBe(false)
		expect(envelopeValue(ctx, page({}), "nextCursor")).toBeNull()
		expect(envelopeValue(ctx, page({}, { link: "" }), "hasMore")).toBe(false)
		expect(envelopeValue(ctx, page({}, { link: "not a link" }), "hasMore")).toBe(false)
		const firstOnly = page({}, { link: '<https://api.test/notes?page=1>; rel="first"' })
		expect(envelopeValue(ctx, firstOnly, "hasMore")).toBe(false)
		expect(envelopeValue(ctx, firstOnly, "nextCursor")).toBeNull()
	})
})

describe("list", () => {
	it("reads one page of the context's list with its auth and query", async () => {
		const rows = [{ id: "1" }, { id: "2" }]
		const { ctx, sent } = notesContext(() => ({ body: rows, status: 200 }), { auth: () => ({ authorization: "a" }) })
		const result = await list(ctx, { limit: 2 })
		expect(result.items).toEqual(rows)
		expect(result.exchange.status).toBe(200)
		expect(sent).toEqual([
			{
				method: "GET",
				options: { headers: { authorization: "a" }, operationId: "note.list", query: { limit: 2 } },
				path: "/notes",
			},
		])
	})

	it("reads the items under the context's collection key", async () => {
		const { ctx } = notesContext(() => ({ body: { items: [{ id: "1" }], total: 1 }, status: 200 }), {
			collectionKey: "items",
		})
		const result = await list(ctx)
		expect(result.items).toEqual([{ id: "1" }])
		expect(result.envelope).toEqual({ items: [{ id: "1" }], total: 1 })
	})

	it("reads another list under that list's own key, with the auth and scope given", async () => {
		const model = notesModel(TAGS)
		const { ctx, sent } = notesContext(() => ({ body: { data: [{ slug: "s" }] }, status: 200 }), {}, model)
		const result = await list(ctx, {}, { auth: () => ({ who: "b" }), scope: {}, op: op(model, "tag.list") })
		expect(result.items).toEqual([{ slug: "s" }])
		expect(sent[0]).toMatchObject({ options: { headers: { who: "b" }, operationId: "tag.list" }, path: "/tags" })
	})

	it("reads a bare array from a list whose document gives no collection shape", async () => {
		const { ctx } = notesContext(() => ({ body: [{ id: "9" }], status: 200 }))
		const orphan = { ...ctx.listOp, collection: null, operationId: "orphan.list" }
		expect((await list(ctx, {}, { auth: ctx.auth, scope: ctx.scope, op: orphan })).items).toEqual([{ id: "9" }])
	})

	it("takes an empty answer as an empty envelope", async () => {
		const { ctx } = notesContext(() => ({ status: 204 }))
		expect(await list(ctx)).toMatchObject({ envelope: {}, items: [] })
	})
})

describe("forList", () => {
	it("is the context itself for its own list", () => {
		const { ctx } = notesContext()
		expect(forList(ctx, ctx.listOp)).toBe(ctx)
	})

	it("sees another list with that entity's identity, key and query", () => {
		const model = notesModel(TAGS)
		const { ctx } = notesContext(undefined, {}, model)
		const tags = op(model, "tag.list")
		expect(forList(ctx, tags)).toMatchObject({
			collectionKey: "data",
			identity: "slug",
			listOp: tags,
			query: tags.query,
		})
	})

	it("falls back to `id` and no key for a list no entity owns", () => {
		const { ctx } = notesContext()
		const orphan = { ...ctx.listOp, collection: null, entity: null, operationId: "orphan.list" }
		expect(forList(ctx, orphan)).toMatchObject({ collectionKey: null, identity: "id" })
	})
})

describe("extractItems", () => {
	it("reads a bare array, or the array under the key", () => {
		expect(extractItems([{ id: "1" }], null)).toEqual([{ id: "1" }])
		expect(extractItems({ rows: [{ id: "1" }] }, "rows")).toEqual([{ id: "1" }])
	})

	it("keeps only the rows that are records", () => {
		expect(extractItems([null, { id: "1" }, 7, [{ id: "2" }], "x"], null)).toEqual([{ id: "1" }])
		expect(extractItems({ rows: [null, { id: "1" }] }, "rows")).toEqual([{ id: "1" }])
	})

	it("finds nothing in anything else", () => {
		expect(extractItems(null, "rows")).toEqual([])
		expect(extractItems("text", "rows")).toEqual([])
		expect(extractItems({ rows: "x" }, "rows")).toEqual([])
		expect(extractItems({ rows: [{ id: "1" }] }, null)).toEqual([])
	})
})

describe("ids", () => {
	it("lists the identities records carry, skipping those without one", () => {
		expect(ids([{ id: "1" }, { name: "x" }, { id: 2 }], "id")).toEqual(["1", "2"])
	})
})
