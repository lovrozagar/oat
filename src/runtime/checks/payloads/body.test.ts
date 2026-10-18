import { describe, expect, it } from "vitest"
import type { CheckContext } from "../core/context.ts"
import { op } from "../__fixtures__/harness.ts"
import { notesContext, notesModel } from "../query/__fixtures__/notes.ts"
import {
	changedValue,
	createExchange,
	encodeOpBody,
	pickWritableStringField,
	propertySchemaOf,
	requestSchemaOf,
	validBody,
} from "./body.ts"

/*
 * Request bodies the checks send: a valid body to base a negative probe on, a changed value for a
 * write probe, the field a write may change, and the exchange that made the cohort's record.
 */

const FORM = {
	"/notes/import": {
		post: {
			operationId: "note.import",
			requestBody: {
				content: {
					"application/x-www-form-urlencoded": { schema: { properties: { name: { type: "string" } }, type: "object" } },
				},
			},
			responses: { "204": { description: "imported" } },
		},
	},
}

/** The notes context with `properties` as the list's item schema. */
function itemOf(properties: Record<string, unknown>): CheckContext {
	const { ctx } = notesContext()
	const collection = ctx.listOp.collection
	if (collection === null) throw new Error("the notes list is a collection")
	return { ...ctx, listOp: { ...ctx.listOp, collection: { ...collection, itemSchema: { properties } } } }
}

describe("propertySchemaOf", () => {
	it("takes the operation's request schema first, then the item's", () => {
		const { ctx } = notesContext()
		expect(propertySchemaOf(ctx, "rank", ctx.createOp)).toMatchObject({ type: "integer" })
		expect(propertySchemaOf(ctx, "tag", ctx.createOp)).toMatchObject({ type: ["string", "null"] })
		expect(propertySchemaOf(ctx, "tag")).toMatchObject({ type: ["string", "null"] })
		expect(propertySchemaOf(ctx, "tag", ctx.deleteOp)).toMatchObject({ type: ["string", "null"] })
	})

	it("is undefined for a field neither declares", () => {
		const { ctx } = notesContext()
		expect(propertySchemaOf(ctx, "missing", ctx.createOp)).toBeUndefined()
		expect(propertySchemaOf({ ...ctx, listOp: { ...ctx.listOp, collection: null } }, "missing")).toBeUndefined()
	})
})

describe("changedValue", () => {
	it("is a valid value that differs from the current one", () => {
		const { ctx } = notesContext()
		const next = changedValue(ctx, "name", "a", ctx.updateOp)
		expect(typeof next).toBe("string")
		expect(next).not.toBe("a")
		expect(changedValue(ctx, "rank", 1)).not.toBe(1)
	})

	it("is undefined for an undeclared field, or one with no other valid value", () => {
		expect(changedValue(notesContext().ctx, "missing", "a")).toBeUndefined()
		expect(changedValue(itemOf({ kind: { enum: ["only"], type: "string" } }), "kind", "only")).toBeUndefined()
	})
})

describe("pickWritableStringField", () => {
	it("picks the first non-empty string a write may change", () => {
		const { ctx } = notesContext()
		const record = { created_at: "t", id: "n1", owner_id: "o", rank: 1, title: "", name: "a" }
		expect(pickWritableStringField(ctx, record)).toBe("name")
	})

	it("passes over fields the update declares immutable or generated", () => {
		const { ctx } = notesContext()
		const updateOp = ctx.updateOp
		if (updateOp === undefined) throw new Error("the notes have an update")
		const guarded = { ...ctx, updateOp: { ...updateOp, generated: ["slug"], immutable: ["name"] } }
		expect(pickWritableStringField(guarded, { body: "b", name: "a", slug: "s" })).toBe("body")
		expect(pickWritableStringField(guarded, { name: "a", slug: "s" })).toBeNull()
		expect(pickWritableStringField({ ...ctx, updateOp: undefined }, { name: "a" })).toBe("name")
	})
})

describe("createExchange", () => {
	it("is the successful create under this scope's path, read back in full", async () => {
		const { ctx } = notesContext(() => ({ body: { id: "n1" }, status: 201 }))
		await ctx.client.request("POST", "/notes", { operationId: "note.create" })
		expect((await createExchange(ctx))?.responseBody).toEqual({ id: "n1" })
	})

	it("is undefined without a successful create at that path", async () => {
		const { ctx } = notesContext(() => ({ status: 400 }))
		expect(await createExchange(ctx)).toBeUndefined()
		await ctx.client.request("POST", "/notes", { operationId: "note.create" })
		expect(await createExchange(ctx)).toBeUndefined()
		const elsewhere = notesContext(() => ({ status: 201 })).ctx
		await elsewhere.client.request("POST", "/other", { operationId: "note.create" })
		expect(await createExchange(elsewhere)).toBeUndefined()
	})

	it("is undefined without a create, or a path this scope can fill", async () => {
		const { ctx } = notesContext()
		expect(await createExchange({ ...ctx, createOp: undefined })).toBeUndefined()
		const createOp = ctx.createOp
		if (createOp === undefined) throw new Error("the notes have a create")
		const nested = { ...ctx, createOp: { ...createOp, path: "/orgs/{orgId}/notes" } }
		expect(await createExchange(nested)).toBeUndefined()
	})
})

/** The create's request body schema. */
const schema = (ctx: CheckContext) => requestSchemaOf(ctx, ctx.createOp ?? ctx.listOp) ?? {}

describe("validBody", () => {
	it("builds a body the document accepts, every string salted so no two bodies collide", () => {
		const { ctx } = notesContext()
		const first = validBody(ctx, schema(ctx))
		const second = validBody(ctx, schema(ctx))
		expect(typeof first.name).toBe("string")
		expect(first.name).not.toBe(second.name)
	})

	it("makes each unique set distinct, and reserves a client-chosen identity", () => {
		const taken = new Set<string>()
		const { ctx } = notesContext(undefined, { takenIdentities: taken, uniqueSets: [["name"]] })
		const withId = { properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] }
		const body = validBody(ctx, withId)
		expect(taken).toEqual(new Set([body.id]))
		expect(validBody(ctx, withId).name).not.toBe(body.name)
	})

	it("builds without a create operation or unique sets", () => {
		const { ctx } = notesContext()
		const bare = { ...ctx, createOp: undefined, uniqueSets: undefined } as unknown as CheckContext
		expect(validBody(bare, { properties: { name: { type: "string" } }, required: ["name"] })).toHaveProperty("name")
	})
})

describe("requestSchemaOf", () => {
	it("is the operation's request body schema, or null without one", () => {
		const { ctx } = notesContext()
		expect(requestSchemaOf(ctx, ctx.listOp)).toBeNull()
		expect(requestSchemaOf(ctx, { ...ctx.listOp, operationId: "note.unknown" })).toBeNull()
		expect(requestSchemaOf(ctx, ctx.createOp ?? ctx.listOp)).toMatchObject({ required: ["name"] })
	})
})

describe("encodeOpBody", () => {
	it("encodes the fields as the operation's request body", async () => {
		const { ctx } = notesContext()
		const encoded = await encodeOpBody(ctx, ctx.createOp ?? ctx.listOp, { name: "a" })
		expect(encoded.body).toEqual({ name: "a" })
	})

	it("names the media type when the operation takes something other than JSON", async () => {
		const model = notesModel(FORM)
		const { ctx } = notesContext(undefined, {}, model)
		const encoded = await encodeOpBody(ctx, op(model, "note.import"), { name: "a" })
		expect(encoded.contentType).toBe("application/x-www-form-urlencoded")
		expect(String(encoded.body)).toBe("name=a")
	})

	it("sends the fields as they are for an operation without a request body", async () => {
		const { ctx } = notesContext()
		expect(
			await encodeOpBody(ctx, ctx.listOp, { name: "a" }, { variant: "baseline", index: 0, uploads: ctx.uploads }),
		).toEqual({
			body: { name: "a" },
		})
	})
})
