import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import { FencedError } from "../../../fence.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { notesContext, notesModel, notesServer } from "./__fixtures__/notes.ts"
import { confirmedIdentity, liveRecord } from "./records.ts"

/*
 * The records the write checks compare against: an acknowledged create's id is believed only once
 * the entity's read returns it with what was sent, and a live record comes from the item read.
 */

const MODEL = notesModel()
const NOTE = { code: "c", id: "n7", name: "seven", size: 7 }

function stage(respond: Responder, fields = {}) {
	return notesContext(MODEL, respond, fields)
}

describe("confirmedIdentity", () => {
	it("proves the id a create was sent once the read returns it with the fields sent", async () => {
		const server = notesServer([NOTE])
		const { ctx, sent } = stage(server.respond)
		const confirmed = await confirmedIdentity(ctx, ctx.client, { id: "n7", name: "seven", size: 7 })
		expect(confirmed).toEqual({ id: "n7", record: NOTE })
		expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /notes/n7"])
	})

	it("does not prove an id the read returns with other values", async () => {
		const { ctx } = stage(notesServer([NOTE]).respond)
		expect(await confirmedIdentity(ctx, ctx.client, { id: "n7", name: "other" })).toBeUndefined()
	})

	it("leaves out the fields it is told to ignore", async () => {
		const { ctx } = stage(notesServer([NOTE]).respond)
		const confirmed = await confirmedIdentity(ctx, ctx.client, { id: "n7", name: "seven", title: "lost" }, ["title"])
		expect(confirmed?.id).toBe("n7")
	})

	it("reads only through the read this context may call", async () => {
		const { ctx, sent } = stage(notesServer([NOTE]).respond, { readOp: undefined })
		expect(await confirmedIdentity(ctx, ctx.client, { id: "n7", name: "seven" })).toBeUndefined()
		expect(sent).toEqual([])
	})
})

describe("liveRecord", () => {
	it("is the record the item read returns", async () => {
		const { ctx, sent } = stage(notesServer([NOTE]).respond)
		expect(await liveRecord(ctx, "n7")).toEqual(NOTE)
		expect(sent[0]?.path).toBe("/notes/n7")
	})

	it("is nothing without an id or an item read, and sends nothing", async () => {
		const { ctx, sent } = stage(notesServer([NOTE]).respond)
		expect(await liveRecord(ctx, undefined)).toBeUndefined()
		expect(await liveRecord({ ...ctx, readOp: undefined }, "n7")).toBeUndefined()
		expect(sent).toEqual([])
	})

	it("is nothing when the read is refused or answers no object", async () => {
		for (const answer of [{ status: 404 }, { body: null, status: 200 }, { body: "n7", status: 200 }]) {
			const { ctx } = stage(() => answer)
			expect(await liveRecord(ctx, "n7")).toBeUndefined()
		}
	})

	it("is nothing when the read fails", async () => {
		const { ctx } = stage(() => {
			throw new Error("socket closed")
		})
		expect(await liveRecord(ctx, "n7")).toBeUndefined()
	})

	it("passes a fenced read on, so the caller hears it could not ask", async () => {
		const fenced = new FencedError({ method: "GET", phase: "check", reason: "fenced", url: "/notes/n7" })
		const { ctx } = stage(() => {
			throw fenced
		})
		await expect(liveRecord(ctx, "n7")).rejects.toBe(fenced)
	})

	it("passes a read whose security cannot be met on, so the caller is untested with the reason", async () => {
		const blocked = new UnsatisfiedSecurity("blocked", "alpha is BLOCKED: login failed")
		const { ctx } = stage(() => {
			throw blocked
		})
		await expect(liveRecord(ctx, "n7")).rejects.toBe(blocked)
	})
})
