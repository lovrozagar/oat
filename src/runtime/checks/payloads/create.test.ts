import { describe, expect, it } from "vitest"
import type { Responder } from "../__fixtures__/harness.ts"
import { notesContext } from "../query/__fixtures__/notes.ts"
import { createFresh, type Fresh } from "./create.ts"

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

/* The create a test expects was sent. */
function sentOf(fresh: Fresh): Extract<Fresh, { exchange: unknown }> {
	if ("withheld" in fresh) throw new Error(fresh.withheld)
	return fresh
}

function setup(respond: Responder, tracked: boolean) {
	const { ctx, sent } = notesContext(respond, tracked ? { takenIdentities: new Set<string>() } : {})
	const createOp = ctx.createOp
	if (createOp === undefined) throw new Error("the notes have a create")
	return { createOp, ctx, sent }
}

describe("createFresh", () => {
	it("posts one valid body to the create's path as the principal given", async () => {
		const { createOp, ctx, sent } = setup(answering(201), false)
		const made = sentOf(await createFresh(ctx, createOp, WITHOUT_ID, "a"))
		expect(made.exchange.status).toBe(201)
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({
			method: "POST",
			options: { as: { principal: "a" }, body: made.sent, operationId: "note.create" },
			path: "/notes",
		})
	})

	it("tries another client-chosen identity on a 409", async () => {
		const { createOp, ctx, sent } = setup(answering(409, 201), true)
		const made = sentOf(await createFresh(ctx, createOp, WITH_ID, "alpha"))
		expect(made.exchange.status).toBe(201)
		expect(sent).toHaveLength(2)
		const ids = sent.map((request) => (request.options.body as { id: string }).id)
		expect(new Set(ids).size).toBe(2)
		expect(made.sent.id).toBe(ids[1])
	})

	it("gives the 409 back after three identities, says why, and keeps every refused one taken", async () => {
		const { createOp, ctx, sent } = setup(answering(409, 409, 409, 201), true)
		const made = sentOf(await createFresh(ctx, createOp, WITH_ID, "alpha"))
		const ids = sent.map((request) => (request.options.body as { id: string }).id)
		expect(made.exchange.status).toBe(409)
		expect(sent).toHaveLength(3)
		expect(made.exhausted).toBe(
			`every client-chosen "id" sent was refused with 409 (${ids.join(", ")}); no fourth create was sent`,
		)
		expect(ids.every((id) => ctx.takenIdentities?.has(id))).toBe(true)
	})

	it("draws its fresh identities without a nonce when the run has none", async () => {
		const { createOp, ctx, sent } = setup(answering(409, 201), true)
		delete (ctx as { nonce?: string }).nonce
		expect(sentOf(await createFresh(ctx, createOp, WITH_ID, "alpha")).exchange.status).toBe(201)
		expect(sent).toHaveLength(2)
	})

	it("gives a 409 straight back when oat does not choose the identity", async () => {
		const untracked = setup(answering(409), false)
		expect(sentOf(await createFresh(untracked.ctx, untracked.createOp, WITH_ID, "alpha")).exchange.status).toBe(409)
		expect(untracked.sent).toHaveLength(1)
		const noId = setup(answering(409), true)
		expect(sentOf(await createFresh(noId.ctx, noId.createOp, WITHOUT_ID, "alpha")).exchange.status).toBe(409)
		expect(noId.sent).toHaveLength(1)
	})

	it("gives any other refusal straight back", async () => {
		const { createOp, ctx, sent } = setup(answering(422), true)
		expect(sentOf(await createFresh(ctx, createOp, WITH_ID, "alpha")).exchange.status).toBe(422)
		expect(sent).toHaveLength(1)
	})
})

/* A client-chosen integer identity in a small range, as a server whose id space spans tenants takes them. */
const WITH_INTEGER_ID = {
	properties: { id: { maximum: 999, minimum: 1, type: "integer" }, name: { minLength: 1, type: "string" } },
	required: ["id", "name"],
	type: "object",
}

const idsOf = (sent: ReturnType<typeof setup>["sent"]) =>
	sent.map((request) => (request.options.body as { id: number }).id)

describe("createFresh with a bounded integer identity", () => {
	it("sends another identity when the first is taken", async () => {
		const { createOp, ctx, sent } = setup(answering(409, 201), true)
		const made = sentOf(await createFresh(ctx, createOp, WITH_INTEGER_ID, ctx.actor.id))
		const ids = idsOf(sent)
		expect(made.exchange.status).toBe(201)
		expect(sent).toHaveLength(2)
		expect(ids[1]).not.toBe(ids[0])
		expect(made.sent.id).toBe(ids[1])
	})

	it("gives up after three distinct identities, answering the last 409", async () => {
		const { createOp, ctx, sent } = setup(answering(...Array<number>(10).fill(409)), true)
		const made = sentOf(await createFresh(ctx, createOp, WITH_INTEGER_ID, ctx.actor.id))
		expect(made.exchange.status).toBe(409)
		expect(new Set(idsOf(sent)).size).toBe(3)
	})
})

describe("createFresh as a principal a higher rank outranks", () => {
	it("withholds a create a higher rank alone may send, sending nothing", async () => {
		const { createOp, ctx, sent } = setup(answering(201), false)
		const ranked = {
			...ctx,
			actors: [
				{ ...ctx.actor, id: "top", rank: 2 },
				{ ...ctx.actor, id: "low", rank: 0 },
			],
		}
		const required = { ...createOp, privilegedRequired: ["name"] }
		expect(await createFresh(ranked, required, WITHOUT_ID, "low")).toEqual({
			withheld:
				"note.create requires name, marked x-privileged, which only top (rank 2) may set; low (rank 0) does not send it",
		})
		expect(sent).toEqual([])
		expect("exchange" in (await createFresh(ranked, required, WITHOUT_ID, "top"))).toBe(true)
	})
})
