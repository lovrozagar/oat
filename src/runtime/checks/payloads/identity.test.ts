import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../../spec/graph.ts"
import type { CheckContext } from "../core/context.ts"
import { notesContext } from "../query/__fixtures__/notes.ts"
import {
	absentId,
	choosesIdentity,
	constructedAbsentId,
	NO_ABSENT_ID,
	reserveClientIdentity,
	saltOf,
} from "./identity.ts"

/*
 * Identities oat invents. An absent id must have the identity's own shape, or the backend refuses
 * it as malformed before existence is considered. A client-chosen identity is reserved before the
 * request goes out, so no two bodies — and no body and existing record — share one.
 */

const ITEM_ID = { in: "path", name: "noteId", required: true } as const

/** The notes context with the record identity typed `identity` and the read's id parameter `param`. */
function shaped(identity: Record<string, unknown> | undefined, param?: Record<string, unknown>): CheckContext {
	const { ctx } = notesContext()
	const collection = ctx.listOp.collection
	if (collection === null) throw new Error("the notes list is a collection")
	const properties = identity === undefined ? {} : { id: identity }
	const rawOperations = new Map(ctx.model.rawOperations)
	const raw = rawOperations.get("note.read")
	rawOperations.set("note.read", {
		...raw,
		parameters: [param === undefined ? ITEM_ID : { ...ITEM_ID, schema: param }],
	})
	return {
		...ctx,
		listOp: { ...ctx.listOp, collection: { ...collection, itemSchema: { properties } } },
		model: { ...ctx.model, rawOperations },
	} as CheckContext
}

describe("absentId", () => {
	it("takes the record's identity type over a route parameter documented as a bare string", () => {
		expect(absentId(shaped({ type: "integer" }, { type: "string" }))).toMatch(/^[0-9]+$/)
		expect(absentId(shaped({ type: "string" }, { type: "string" }))).toMatch(/^oat-absent-/)
		expect(absentId(shaped(undefined, { type: "string" }))).toMatch(/^oat-absent-/)
	})

	it("takes a route parameter that narrows the identity", () => {
		expect(absentId(shaped({ type: "integer" }, { format: "uuid", type: "string" }))).toMatch(/^[0-9a-f-]{36}$/)
		expect(absentId(shaped({ type: "string" }, { type: "integer" }))).toMatch(/^[0-9]+$/)
	})

	it("looks past an item operation whose parameter has no schema to the next one", () => {
		const ctx = shaped({ type: "integer" })
		expect(absentId(ctx)).toMatch(/^[0-9]+$/)
		const listAsRead = { ...ctx, readOp: ctx.listOp as OperationModel }
		expect(absentId(listAsRead)).toMatch(/^[0-9]+$/)
	})

	it("looks past item operations the document does not describe, or describes without parameters", () => {
		const ctx = shaped({ type: "integer" })
		const unknown = { ...ctx.listOp, operationId: "note.unknown", pathParams: ["noteId"] }
		const bare = { deleteOp: ctx.createOp, readOp: unknown, updateOp: undefined }
		expect(absentId({ ...ctx, ...bare })).toMatch(/^[0-9]+$/)
		const { ctx: plain } = notesContext()
		expect(absentId({ ...plain, ...bare, listOp: { ...plain.listOp, collection: null } })).toMatch(/^oat-absent-/)
	})

	it("falls back to the record's identity, then to a string, without item operations", () => {
		const none = { deleteOp: undefined, readOp: undefined, updateOp: undefined }
		expect(absentId({ ...shaped({ type: "integer" }), ...none })).toMatch(/^[0-9]+$/)
		expect(absentId({ ...shaped(undefined), ...none })).toMatch(/^oat-absent-/)
	})

	it("is null when the identity's schema admits no such identifier", () => {
		expect(
			constructedAbsentId(shaped({ pattern: "^[0-9]{3}$", type: "string" }, { pattern: "^[0-9]{3}$", type: "string" })),
		).toBeNull()
		expect(NO_ABSENT_ID).toContain("names no record")
	})

	it("draws on the context's nonce, or oat's own without one", () => {
		const ctx = shaped({ type: "string" }, { type: "string" })
		const withoutNonce = absentId({ ...ctx, nonce: undefined } as unknown as CheckContext)
		expect(withoutNonce).toBe(absentId({ ...ctx, nonce: "oat" }))
		expect(withoutNonce).not.toBe(absentId({ ...ctx, nonce: "another" }))
	})
})

describe("saltOf", () => {
	it("draws the run's next salt when there is one", () => {
		const salts = ["a", "b"]
		const { ctx } = notesContext(undefined, { nextSalt: () => salts.shift() ?? "" })
		expect([saltOf(ctx), saltOf(ctx)]).toEqual(["a", "b"])
	})

	it("counts the bodies its entity made outside a run", () => {
		const { ctx } = notesContext()
		expect([saltOf(ctx), saltOf(ctx), saltOf(ctx)]).toEqual(["p1", "p2", "p3"])
	})
})

describe("reserveClientIdentity", () => {
	const SCHEMA = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }

	it("reserves a free client-chosen identity before the request goes out", () => {
		const taken = new Set<string>()
		const { ctx } = notesContext(undefined, { takenIdentities: taken })
		expect(reserveClientIdentity(ctx, { id: "n1", name: "a" }, SCHEMA, "s")).toEqual({ id: "n1", name: "a" })
		expect(taken).toEqual(new Set(["n1"]))
	})

	it("moves a taken identity onto one no record holds", () => {
		const taken = new Set(["n1"])
		const { ctx } = notesContext(undefined, { takenIdentities: taken })
		const reserved = reserveClientIdentity(ctx, { id: "n1", name: "a" }, SCHEMA, "s")
		expect(reserved.id).not.toBe("n1")
		expect(reserved.name).toBe("a")
		expect(taken).toEqual(new Set(["n1", reserved.id]))
	})

	it("refuses when no free identity is left", () => {
		const { ctx } = notesContext(undefined, { takenIdentities: new Set(["only"]) })
		const single = { properties: { id: { enum: ["only"], type: "string" } }, type: "object" }
		expect(() => reserveClientIdentity(ctx, { id: "only" }, single, "s")).toThrow(/no "id" is left/)
	})

	it("leaves a body alone when oat does not choose its identity", () => {
		const { ctx } = notesContext()
		expect(reserveClientIdentity(ctx, { id: "n1" }, SCHEMA, "s")).toEqual({ id: "n1" })
		const taken = new Set<string>()
		const tracked = notesContext(undefined, { takenIdentities: taken }).ctx
		expect(reserveClientIdentity(tracked, { name: "a" }, { properties: { name: {} } }, "s")).toEqual({ name: "a" })
		expect(reserveClientIdentity(tracked, { name: "a" }, SCHEMA, "s")).toEqual({ name: "a" })
		expect(taken).toEqual(new Set())
	})
})

describe("choosesIdentity", () => {
	it("holds when identities are tracked and the create body carries one", () => {
		const tracked = notesContext(undefined, { takenIdentities: new Set() }).ctx
		expect(choosesIdentity(tracked, { properties: { id: {} } })).toBe(true)
		expect(choosesIdentity(tracked, { properties: { name: {} } })).toBe(false)
		expect(choosesIdentity(tracked, {})).toBe(false)
		expect(choosesIdentity(notesContext().ctx, { properties: { id: {} } })).toBe(false)
	})
})
