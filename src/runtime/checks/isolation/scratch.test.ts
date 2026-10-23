import { describe, expect, it } from "vitest"
import { exchange, type Responder } from "../__fixtures__/harness.ts"
import { modelOf } from "../__fixtures__/harness.ts"
import { notesContext, notesDoc, notesModel } from "../query/__fixtures__/notes.ts"
import { readRecord, scratchRecord, updateRequest } from "./scratch.ts"

/*
 * A mutating check writes to a record made for it, never to the cohort every read-only oracle
 * planned against. When that record cannot be made the check says why: no create to make it with,
 * a documented feature gate, or a create that did not name the record it made.
 */

const CHECK = "patch.minimality"

const creating =
	(answer: { status: number; body?: unknown }): Responder =>
	(method) =>
		method === "POST" ? answer : undefined

describe("readRecord", () => {
	it("is the record a single-record answer holds", () => {
		const { ctx } = notesContext()
		const readOp = ctx.readOp ?? ctx.listOp
		expect(readRecord(readOp, exchange("GET", "/notes/n1", { body: { id: "n1" }, status: 200 }))).toEqual({ id: "n1" })
	})
})

describe("scratchRecord", () => {
	it("makes a record of the check's own and names it", async () => {
		const { ctx, sent } = notesContext(creating({ body: { id: "n9", name: "x" }, status: 201 }))
		const made = await scratchRecord(ctx, CHECK)
		expect(made).toMatchObject({ scratch: { id: "n9", record: { id: "n9", name: "x" } } })
		expect("scratch" in made ? made.scratch.exchange.status : 0).toBe(201)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /notes"])
		expect(sent[0]?.options.as).toEqual({ principal: ctx.actor.id })
	})

	it("names a numeric identity as text", async () => {
		const { ctx } = notesContext(creating({ body: { id: 7, name: "x" }, status: 201 }))
		expect(await scratchRecord(ctx, CHECK)).toMatchObject({ scratch: { id: "7" } })
	})

	it("confirms by a read the identity oat chose when the create answers none", async () => {
		let made: unknown
		const respond: Responder = (method, path, options) => {
			if (method === "POST") made = options.body
			if (method === "POST") return { body: { ok: true }, status: 201 }
			return path.startsWith("/notes/") ? { body: made, status: 200 } : undefined
		}
		const { ctx, sent } = notesContext(respond, { takenIdentities: new Set() })
		const input = { properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] }
		const rawOperations = new Map(ctx.model.rawOperations)
		rawOperations.set("note.create", {
			...rawOperations.get("note.create"),
			requestBody: { content: { "application/json": { schema: input } } },
		})
		const scratch = await scratchRecord({ ...ctx, model: { ...ctx.model, rawOperations } }, CHECK)
		const id = (made as { id: string }).id
		expect(scratch).toMatchObject({ scratch: { id, record: made } })
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
			"POST /notes",
			`GET /notes/${encodeURIComponent(id)}`,
		])
		/* The record is the actor's: it makes it, and reads it back, as itself. */
		expect(sent.map((request) => request.options.as)).toEqual([{ principal: "alpha" }, { principal: "alpha" }])
	})
})

describe("scratchRecord, when no record can be made", () => {
	it("stands down without a create that takes a request body", async () => {
		const { ctx, sent } = notesContext()
		const reason = "a create operation with a request body, to make a record this check may change"
		expect(await scratchRecord({ ...ctx, createOp: undefined }, CHECK)).toEqual({
			outcome: { kind: "stood-down", reason },
		})
		expect(await scratchRecord({ ...ctx, createOp: ctx.deleteOp }, CHECK)).toEqual({
			outcome: { kind: "stood-down", reason },
		})
		expect(sent).toEqual([])
	})

	it("stands down on the 403 a documented feature gate answers", async () => {
		const body = { vars: { feature: "notes", type: "feature_gate" } }
		const { ctx, findings } = notesContext(creating({ body, status: 403 }))
		const createOp = ctx.createOp
		if (createOp === undefined) throw new Error("the notes have a create")
		const gated = { ...ctx, createOp: { ...createOp, featureGate: "notes" } }
		expect(await scratchRecord(gated, CHECK)).toEqual({
			outcome: { kind: "stood-down", reason: "a documented feature gate refused the request" },
		})
		expect(findings.findings).toMatchObject([{ check: CHECK, verdict: "COVERAGE_GAP" }])
	})

	it("is unresolved when the create is refused", async () => {
		const { ctx, findings } = notesContext(creating({ status: 500 }))
		expect(await scratchRecord(ctx, CHECK)).toEqual({
			outcome: { kind: "unresolved", reason: "a record for this check could not be made: the create answered 500" },
		})
		expect(findings.inconclusive).toHaveLength(1)
	})

	it("says why when every client-chosen identity the create drew was refused with 409", async () => {
		const model = notesModel()
		const raw = structuredClone(model.rawOperations.get("note.create")) as { requestBody: unknown }
		raw.requestBody = { content: { "application/json": { schema: { properties: { id: { type: "string" } } } } } }
		const clientIds = { ...model, rawOperations: new Map([...model.rawOperations, ["note.create", raw as never]]) }
		const { ctx, sent } = notesContext(creating({ status: 409 }), { takenIdentities: new Set() }, clientIds)
		const ids = (): string[] => sent.map((request) => (request.options.body as { id: string }).id)
		const made = await scratchRecord(ctx, CHECK)
		expect(made).toEqual({
			outcome: {
				kind: "unresolved",
				reason: `a record for this check could not be made: every client-chosen "id" sent was refused with 409 (${ids().join(", ")}); no fourth create was sent`,
			},
		})
	})

	it("is unresolved when the create names no id oat could read", async () => {
		const { ctx } = notesContext(creating({ body: { ok: true }, status: 201 }))
		expect(await scratchRecord(ctx, CHECK)).toEqual({
			outcome: {
				kind: "unresolved",
				reason: "a record for this check could not be made: the create answered 201 without an id oat could read",
			},
		})
	})
})

describe("updateRequest", () => {
	const current = { id: "n1", name: "a", rank: 2, extra: "kept out" }

	it("sends only the changes through a PATCH", async () => {
		const { ctx } = notesContext()
		const updateOp = ctx.updateOp ?? ctx.listOp
		expect(await updateRequest(ctx, updateOp, current, { name: "b" })).toEqual({
			method: "PATCH",
			options: { body: { name: "b" } },
		})
	})

	it("sends the whole representation, changes applied, through a PUT", async () => {
		const { ctx } = notesContext()
		const updateOp = { ...(ctx.updateOp ?? ctx.listOp), method: "put" }
		const request = await updateRequest(ctx, updateOp, current, { name: "b" })
		expect(request).toEqual({ method: "PUT", options: { body: { name: "b", rank: 2 } } })
	})

	it("fills the whole representation from a valid body where the record lacks a field", async () => {
		const { ctx } = notesContext()
		const updateOp = { ...(ctx.updateOp ?? ctx.listOp), method: "PUT" }
		const request = await updateRequest(ctx, updateOp, { id: "n1" }, { rank: 5 })
		expect(request.options.body).toMatchObject({ name: expect.any(String), rank: 5 })
	})

	it("sends the changes over the current record's documented fields alone when the PUT has no body schema", async () => {
		const { ctx } = notesContext()
		const bodiless = { ...(ctx.deleteOp ?? ctx.listOp), method: "PUT" }
		expect(await updateRequest(ctx, bodiless, current, { name: "b" })).toEqual({
			method: "PUT",
			options: { body: { name: "b" } },
		})
	})
})

/* Notes whose PUT body marks `plan` x-privileged, required as `required` says. */
function markedPut(required: string[]) {
	const doc = structuredClone(notesDoc())
	const paths = doc.paths as Record<string, Record<string, { requestBody: unknown }>>
	const put = paths["/notes/{noteId}"]?.["patch"] as { requestBody: unknown }
	put.requestBody = {
		content: {
			"application/json": {
				schema: {
					properties: { name: { type: "string" }, plan: { type: "string", "x-privileged": true } },
					required,
					type: "object",
				},
			},
		},
	}
	const { ctx } = notesContext(undefined, {}, modelOf(doc))
	return { ctx, updateOp: { ...(ctx.updateOp ?? ctx.listOp), method: "PUT" } }
}

describe("updateRequest and a property only the highest rank may set", () => {
	it("leaves an optional one out of a PUT, and keeps a required one", async () => {
		const record = { id: "n1", name: "a", plan: "gold" }
		const optional = markedPut([])
		expect(await updateRequest(optional.ctx, optional.updateOp, record, { name: "b" })).toEqual({
			method: "PUT",
			options: { body: { name: "b" } },
		})
		const required = markedPut(["plan"])
		expect((await updateRequest(required.ctx, required.updateOp, record, { name: "b" })).options.body).toEqual({
			name: "b",
			plan: "gold",
		})
	})
})

describe("scratchRecord as a principal a higher rank outranks", () => {
	it("stands down without sending a create whose body requires a property only the highest rank sets", async () => {
		const { ctx, sent } = notesContext(creating({ body: { id: "n9" }, status: 201 }))
		const low = { ...ctx.actor, id: "low", rank: 0 }
		const createOp = { ...(ctx.createOp ?? ctx.listOp), privilegedRequired: ["name"] }
		const outranked = { ...ctx, actor: low, actors: [{ ...low, id: "top", rank: 1 }, low], createOp }
		expect(await scratchRecord(outranked, CHECK)).toEqual({
			outcome: {
				kind: "stood-down",
				reason:
					"note.create requires name, marked x-privileged, which only top (rank 1) may set; low (rank 0) does not send it",
			},
		})
		expect(sent).toEqual([])
	})
})
