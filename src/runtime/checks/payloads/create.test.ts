import { describe, expect, it } from "vitest"
import type { Responder } from "../__fixtures__/harness.ts"
import { notesContext } from "../query/__fixtures__/notes.ts"
import { createFresh } from "./create.ts"

/*
 * A create meant to succeed. A client-chosen identity oat never saw can still be taken by another
 * tenant's record, so its 409 is retried under another identity a few times; a 409 on a body with
 * no identity of its own is about something else, and comes straight back.
 */

const WITH_ID = { properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] }
const WITHOUT_ID = { properties: { name: { type: "string" } }, required: ["name"] }

const answering =
	(...statuses: number[]): Responder =>
	() => ({ status: statuses.shift() ?? 201 })

function setup(respond: Responder, tracked: boolean) {
	const { ctx, sent } = notesContext(respond, tracked ? { takenIdentities: new Set<string>() } : {})
	const createOp = ctx.createOp
	if (createOp === undefined) throw new Error("the notes have a create")
	return { createOp, ctx, sent }
}

describe("createFresh", () => {
	it("posts one valid body to the create's path with the headers given", async () => {
		const { createOp, ctx, sent } = setup(answering(201), false)
		const made = await createFresh(ctx, createOp, WITHOUT_ID, { authorization: "a" })
		expect(made.exchange.status).toBe(201)
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({
			method: "POST",
			options: { body: made.sent, headers: { authorization: "a" }, operationId: "note.create" },
			path: "/notes",
		})
	})

	it("tries another client-chosen identity on a 409", async () => {
		const { createOp, ctx, sent } = setup(answering(409, 201), true)
		const made = await createFresh(ctx, createOp, WITH_ID, {})
		expect(made.exchange.status).toBe(201)
		expect(sent).toHaveLength(2)
		const ids = sent.map((request) => (request.options.body as { id: string }).id)
		expect(new Set(ids).size).toBe(2)
		expect(made.sent.id).toBe(ids[1])
	})

	it("gives the 409 back after three identities", async () => {
		const { createOp, ctx, sent } = setup(answering(409, 409, 409, 201), true)
		expect((await createFresh(ctx, createOp, WITH_ID, {})).exchange.status).toBe(409)
		expect(sent).toHaveLength(3)
	})

	it("gives a 409 straight back when oat does not choose the identity", async () => {
		const untracked = setup(answering(409), false)
		expect((await createFresh(untracked.ctx, untracked.createOp, WITH_ID, {})).exchange.status).toBe(409)
		expect(untracked.sent).toHaveLength(1)
		const noId = setup(answering(409), true)
		expect((await createFresh(noId.ctx, noId.createOp, WITHOUT_ID, {})).exchange.status).toBe(409)
		expect(noId.sent).toHaveLength(1)
	})

	it("gives any other refusal straight back", async () => {
		const { createOp, ctx, sent } = setup(answering(422), true)
		expect((await createFresh(ctx, createOp, WITH_ID, {})).exchange.status).toBe(422)
		expect(sent).toHaveLength(1)
	})
})
