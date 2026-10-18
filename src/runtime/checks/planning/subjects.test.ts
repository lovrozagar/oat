import { describe, expect, it } from "vitest"
import type { InviteSpec } from "../../../spec/extensions/invite.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../../spec/graph/types.ts"
import { exchange } from "../__fixtures__/harness.ts"
import { notesContext, notesModel } from "../query/__fixtures__/notes.ts"
import { declared, graded, isEventStream, itemParamFor, NO_KEY, ownOps, subjectsOf } from "./subjects.ts"

/*
 * Which operations a check grades, decided from the entity graph alone so a scope can be shown
 * without a network. Each subject set reads the same fields the check's context is built from.
 */

const TAGS = {
	"/tags": {
		get: {
			operationId: "tag.list",
			responses: { "200": { description: "ok" } },
			"x-entity": { action: "list", name: "tag" },
		},
		post: {
			operationId: "tag.create",
			responses: { "201": { description: "ok" } },
			"x-entity": { action: "create", name: "tag" },
		},
	},
}

const ASYNC = { poll: "note.read", pollIntervalMs: 1, timeoutMs: 1 }
const INVITE = { accept: "note.accept", invite: "note.invite", revoke: "note.revoke" } as InviteSpec

/** The notes model with `patch` laid over each named operation, and the note entity with `entity`. */
function notesWith(
	patch: Record<string, Partial<OperationModel>>,
	entityPatch: Partial<EntityModel> = {},
): { entity: EntityModel; model: SpecModel } {
	const base = notesModel(TAGS)
	const operations = base.operations.map((operation) => ({ ...operation, ...patch[operation.operationId] }))
	const byOperationId = new Map(operations.map((operation) => [operation.operationId, operation]))
	const byRoute = new Map(operations.map((operation) => [operation.route, operation]))
	const model = { ...base, byOperationId, byRoute, operations }
	const note = base.entities.get("note")
	if (note === undefined) throw new Error("the notes model has a note entity")
	return { entity: { ...note, ...entityPatch }, model }
}

const route = (model: SpecModel, operationId: string): string => model.byOperationId.get(operationId)?.route ?? ""

describe("graded", () => {
	it("grades every operation unless the run's scope leaves it out", () => {
		const { ctx } = notesContext()
		expect(graded(ctx, ctx.listOp)).toBe(true)
		expect(graded({ ...ctx, inScope: (op) => op.operationId !== "note.list" }, ctx.listOp)).toBe(false)
	})
})

describe("declared and ownOps", () => {
	it("keeps only the operation ids an entity names", () => {
		expect(declared("a", undefined, "", "b")).toEqual(["a", "b"])
	})

	it("lists the entity's own operations that pass the test", () => {
		const { entity, model } = notesWith({})
		expect(ownOps(entity, model, (op) => op.method.toUpperCase() === "GET").sort()).toEqual(["note.list", "note.read"])
	})
})

describe("subjectsOf", () => {
	it("names the entity's declared operations", () => {
		const { entity } = notesWith({})
		expect(subjectsOf.create(entity)).toEqual(["note.create"])
		expect(subjectsOf.createAndList(entity)).toEqual(["note.create", "note.list"])
		expect(subjectsOf.delete(entity)).toEqual(["note.delete"])
		expect(subjectsOf.deleteAndList(entity)).toEqual(["note.delete", "note.list"])
		expect(subjectsOf.list(entity)).toEqual(["note.list"])
		expect(subjectsOf.read(entity)).toEqual(["note.read"])
		expect(subjectsOf.readAndList(entity)).toEqual(["note.read", "note.list"])
		expect(subjectsOf.update(entity)).toEqual(["note.update"])
		expect(subjectsOf.writeAndRead(entity)).toEqual(["note.update", "note.read"])
	})

	it("grades the create and the read when there is no update", () => {
		const { entity } = notesWith({})
		const { update: _, ...noUpdate } = entity
		expect(subjectsOf.writeAndRead(noUpdate)).toEqual(["note.create", "note.read"])
	})

	it("names the operations carrying what a check exercises", () => {
		const { entity, model } = notesWith({
			"note.create": { async: ASYNC, effects: [{ entity: "tag", op: "create" }] },
			"note.read": { featureGate: "exports" },
			"note.update": {
				async: { ...ASYNC, idFrom: "/id" },
				wait: { operationId: "note.read", pollIntervalMs: 1, timeoutMs: 1 },
			},
		})
		expect(subjectsOf.async(entity, model)).toEqual(["note.create", "note.update"])
		expect(subjectsOf.asyncReceipt(entity, model)).toEqual(["note.update"])
		expect(subjectsOf.effects(entity, model)).toEqual(["note.create"])
		expect(subjectsOf.waits(entity, model)).toEqual(["note.update"])
		expect(subjectsOf.nonCreate(entity, model).sort()).toEqual(["note.delete", "note.list", "note.read", "note.update"])
	})

	it("names the read and every gated operation once", () => {
		const gated = notesWith({ "note.list": { featureGate: "exports" }, "note.read": { featureGate: "exports" } })
		expect(subjectsOf.readAndGated(gated.entity, gated.model)).toEqual(["note.read", "note.list"])
	})

	it("names the invite's three operations, or none without one", () => {
		const { entity } = notesWith({}, { invite: INVITE })
		expect(subjectsOf.invite(entity)).toEqual(["note.invite", "note.accept", "note.revoke"])
		expect(subjectsOf.invite(notesWith({}).entity)).toEqual([])
	})
})

describe("subjectsOf.createAndForeignReads", () => {
	it("grades a create with the reads of other entities it says it invalidates", () => {
		const base = notesWith({})
		const invalidates = [
			route(base.model, "tag.list"),
			route(base.model, "tag.create"),
			route(base.model, "note.read"),
			"GET /nowhere",
		]
		const { entity, model } = notesWith({ "note.create": { invalidates } })
		expect(subjectsOf.createAndForeignReads(entity, model)).toEqual(["note.create", "tag.list"])
	})

	it("grades nothing for a create the entity does not have", () => {
		const { entity, model } = notesWith({})
		const { create: _, ...noCreate } = entity
		expect(subjectsOf.createAndForeignReads(noCreate, model)).toEqual([])
	})
})

describe("itemParamFor", () => {
	it("names the item route's last path parameter, from the read, update or delete", () => {
		const { ctx } = notesContext()
		expect(itemParamFor(ctx, "n1")).toEqual({ noteId: "n1" })
		expect(itemParamFor({ ...ctx, readOp: undefined }, "n1")).toEqual({ noteId: "n1" })
		expect(itemParamFor({ ...ctx, readOp: undefined, updateOp: undefined }, "n1")).toEqual({ noteId: "n1" })
	})

	it("is empty without an item route", () => {
		const { ctx } = notesContext()
		expect(itemParamFor({ ...ctx, deleteOp: undefined, readOp: undefined, updateOp: undefined }, "n1")).toEqual({})
		expect(itemParamFor({ ...ctx, readOp: { ...ctx.listOp, pathParams: [] } }, "n1")).toEqual({})
	})
})

describe("isEventStream", () => {
	it("takes the document's word first, then the answer's content type", () => {
		const { ctx } = notesContext()
		const plain = exchange("GET", "/notes", { status: 200 })
		expect(isEventStream(plain, { ...ctx.listOp, eventStream: true })).toBe(true)
		expect(isEventStream(plain, ctx.listOp)).toBe(false)
		expect(isEventStream(plain)).toBe(false)
		const streamed = exchange("GET", "/notes", {
			headers: { "content-type": "text/event-stream; charset=utf-8" },
			status: 200,
		})
		expect(isEventStream(streamed)).toBe(true)
	})
})

describe("NO_KEY", () => {
	it("is no identifier a record could carry", () => {
		expect(NO_KEY.startsWith("\u0000")).toBe(true)
	})
})
