import { describe, expect, it } from "vitest"
import { exchange } from "../__fixtures__/harness.ts"
import { notesContext, notesModel, withConventions } from "../query/__fixtures__/notes.ts"
import { envelopeValue, forList, ids, list, type ListResult } from "./list.ts"
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
	it("reads one page of the context's list as its actor, with its query", async () => {
		const rows = [{ id: "1" }, { id: "2" }]
		const actor = { id: "a", inviteAs: undefined, rank: 0, scope: {}, tenant: undefined }
		const { ctx, sent } = notesContext(() => ({ body: rows, status: 200 }), { actor })
		const result = await list(ctx, { limit: 2 })
		expect(result.items).toEqual(rows)
		expect(result.exchange.status).toBe(200)
		expect(sent).toEqual([
			{
				method: "GET",
				options: { as: { principal: "a" }, operationId: "note.list", query: { limit: 2 } },
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

	it("reads each row's record inside it where the list's recordPath points", async () => {
		const body = { found: 1, hits: [{ document: { id: "1" }, highlights: [] }] }
		const { ctx } = notesContext(() => ({ body, status: 200 }))
		const collection = { ...ctx.listOp.collection, key: "hits", within: ["document"] } as typeof ctx.listOp.collection
		const wrapped = { ...ctx, collectionKey: "hits", listOp: { ...ctx.listOp, collection } }
		expect((await list(wrapped)).items).toEqual([{ id: "1" }])
		const other = { ...ctx.listOp, collection, operationId: "search.list" }
		expect((await list(ctx, {}, { op: other })).items).toEqual([{ id: "1" }])
	})

	it("reads another list under that list's own key, as the principal and in the scope given", async () => {
		const model = notesModel(TAGS)
		const { ctx, sent } = notesContext(() => ({ body: { data: [{ slug: "s" }] }, status: 200 }), {}, model)
		const result = await list(ctx, {}, { op: op(model, "tag.list"), principal: "b", scope: {} })
		expect(result.items).toEqual([{ slug: "s" }])
		expect(sent[0]).toMatchObject({ options: { as: { principal: "b" }, operationId: "tag.list" }, path: "/tags" })
	})

	it("takes an empty answer as an empty envelope", async () => {
		const { ctx } = notesContext(() => ({ status: 204 }))
		expect(await list(ctx)).toMatchObject({ envelope: {}, items: [] })
	})
})

describe("list without a collection shape", () => {
	it("reads a bare array from a list whose document gives no collection shape", async () => {
		const { ctx } = notesContext(() => ({ body: [{ id: "9" }], status: 200 }))
		const orphan = { ...ctx.listOp, collection: null, operationId: "orphan.list" }
		expect((await list(ctx, {}, { op: orphan, principal: ctx.actor.id, scope: ctx.scope })).items).toEqual([
			{ id: "9" },
		])
	})

	it("reads the context's own list as a bare array when its document gives no collection shape", async () => {
		const { ctx } = notesContext(() => ({ body: [{ id: "7" }], status: 200 }))
		const bare = { ...ctx, collectionKey: null, listOp: { ...ctx.listOp, collection: null } }
		expect((await list(bare)).items).toEqual([{ id: "7" }])
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

describe("ids", () => {
	it("lists the identities records carry, skipping those without one", () => {
		expect(ids([{ id: "1" }, { name: "x" }, { id: 2 }], "id")).toEqual(["1", "2"])
	})
})
