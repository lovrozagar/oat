import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../spec/graph/types.ts"
import { listedIds } from "../proven-id.ts"
import type { Record_ } from "../world/records.ts"
import { contextOf, ledgerNotes, notesApi, notesDoc, operationAt, optionsFor, overriding } from "./__fixtures__/api.ts"
import type { RunContext } from "./context.ts"
import { recordTarget, targetReads } from "./security-target.ts"

/* The run-created record a write or item-read probe may target, read back as its creator, or none. */

const op = (ctx: RunContext, id: string): OperationModel => ctx.model.byOperationId.get(id) as OperationModel

async function running(rows: Record_[], ids: string[]): Promise<RunContext> {
	const ctx = await contextOf(optionsFor(notesApi(notesDoc(), rows), {}))
	ledgerNotes(ctx, ids)
	return ctx
}

describe("recordTarget", () => {
	it("targets a run-created record for a read of one record as for a write, never for a collection read", async () => {
		const ctx = await running([{ id: "n1", title: "a" }], ["n1"])
		expect(await recordTarget(ctx, op(ctx, "notes.get"))).toMatchObject({ id: "n1", path: "/notes/n1" })
		expect(await recordTarget(ctx, op(ctx, "notes.list"))).toBeUndefined()
	})

	it("fills the item path from a run-created record and reads its current state back", async () => {
		const ctx = await running([{ id: "n1", title: "here" }], ["n1"])
		expect(await recordTarget(ctx, op(ctx, "notes.update"))).toEqual({
			current: { id: "n1", title: "here" },
			entity: "note",
			id: "n1",
			owner: "alpha",
			params: { note_id: "n1" },
			path: "/notes/n1",
		})
	})

	it("is undefined when the run created no record of the operation's entity", async () => {
		const ctx = await running([{ id: "n1", title: "a" }], [])
		expect(await recordTarget(ctx, op(ctx, "notes.update"))).toBeUndefined()
		expect(await recordTarget(ctx, op(ctx, "notes.get"))).toBeUndefined()
	})

	it("reads the current state as undefined when the record cannot be read back", async () => {
		const ctx = await running([], ["gone"])
		expect(await recordTarget(ctx, op(ctx, "notes.update"))).toMatchObject({ current: undefined, id: "gone" })
	})
})

describe("recordTarget: a creator whose credential is BLOCKED", () => {
	it("is untested, citing the block, when the record cannot be read back as its creator", async () => {
		const ctx = await running([{ id: "n1", title: "a" }], ["n1"])
		ctx.store.block({ principal: "alpha", scheme: "bearer" }, "the new credential is refused")
		const untested = {
			untested:
				"notes.update's target could not be read back: alpha's credential is BLOCKED (the new credential is refused)",
		}
		expect(await recordTarget(ctx, op(ctx, "notes.update"))).toEqual(untested)
		expect(await recordTarget(ctx, op(ctx, "notes.update"), targetReads())).toEqual(untested)
	})
})

describe("recordTarget: records it passes over", () => {
	it("skips a record of another entity, and one whose every path parameter its scope already names", async () => {
		const ctx = await running([{ id: "n1", title: "a" }], [])
		const [other, note] = listedIds(["o1", "n1"])
		ctx.ledger.record({ entity: "other", id: other as NonNullable<typeof other>, scope: {} }, { id: "alpha" })
		ctx.ledger.record(
			{ entity: "note", id: note as NonNullable<typeof note>, scope: { note_id: "n1" } },
			{ id: "alpha" },
		)
		expect(await recordTarget(ctx, op(ctx, "notes.update"))).toBeUndefined()
	})

	it("is untested when no credential can be sent for its creator, a principal the run does not know", async () => {
		const ctx = await running([{ id: "n1", title: "a" }], [])
		const [note] = listedIds(["n1"])
		ctx.ledger.record({ entity: "note", id: note as NonNullable<typeof note>, scope: {} }, { id: "ghost" })
		expect(await recordTarget(ctx, op(ctx, "notes.update"))).toEqual({
			untested: `notes.update's target could not be read back: ghost's credential is BLOCKED (no principal "ghost" in the config)`,
		})
	})

	it("leaves the current state undefined when the read fails on the way", async () => {
		const failing = overriding(notesApi(notesDoc(), [{ id: "n1", title: "a" }]), (method, path) => {
			if (method === "GET" && path === "/notes/n1") throw new Error("connect ECONNRESET")
			return undefined
		})
		const ctx = await contextOf(optionsFor(failing, {}))
		ledgerNotes(ctx, ["n1"])
		expect(await recordTarget(ctx, op(ctx, "notes.update"))).toMatchObject({ current: undefined, id: "n1" })
	})
})

describe("recordTarget: a parameter's own entity", () => {
	const accept = {
		post: {
			operationId: "invite.accept",
			parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
			responses: { "200": { description: "ok" } },
			"x-entity": { action: "action", name: "note" },
		},
	}

	it("never fills a token with a record of the operation's entity: the token names an invite", async () => {
		const ctx = await contextOf(optionsFor(notesApi(notesDoc({ "/invites/{token}/accept": accept }), []), {}))
		ledgerNotes(ctx, ["n1"])
		expect(await recordTarget(ctx, op(ctx, "invite.accept"))).toBeUndefined()
	})

	it("fills a token from an invite the run created", async () => {
		const ctx = await contextOf(optionsFor(notesApi(notesDoc({ "/invites/{token}/accept": accept }), []), {}))
		ledgerNotes(ctx, ["n1"])
		const [token] = listedIds(["tok1"])
		ctx.ledger.record({ entity: "invite", id: token as NonNullable<typeof token>, scope: {} }, { id: "alpha" })
		expect(await recordTarget(ctx, op(ctx, "invite.accept"))).toMatchObject({
			params: { token: "tok1" },
			path: "/invites/tok1/accept",
		})
	})
})

describe("recordTarget: a create under the record", () => {
	it("never targets another entity's create or list under a run-created record: a collection, not the record", async () => {
		const comments = {
			post: {
				operationId: "comments.create",
				parameters: [{ in: "path", name: "note_id", required: true, schema: { type: "string" } }],
				responses: { "201": { description: "made" } },
				"x-entity": { action: "create", name: "comment" },
			},
		}
		const listed = {
			...comments,
			get: {
				operationId: "comments.list",
				parameters: comments.post.parameters,
				responses: { "200": { description: "listed" } },
				"x-entity": { action: "list", name: "comment" },
			},
		}
		const ctx = await contextOf(optionsFor(notesApi(notesDoc({ "/notes/{note_id}/comments": listed }), []), {}))
		ledgerNotes(ctx, ["n1"])
		expect(await recordTarget(ctx, op(ctx, "comments.create"))).toBeUndefined()
		expect(await recordTarget(ctx, op(ctx, "comments.list"))).toBeUndefined()
	})
})

describe("recordTarget on an enveloped read", () => {
	it("unwraps the record from the envelope the read declares, so the harmless body is the record itself", async () => {
		const doc = notesDoc()
		operationAt(doc, "/notes/{note_id}", "get")["x-entity"] = { action: "read", name: "note", recordPath: "$.data" }
		const rows = [{ id: "n1", title: "here" }]
		const enveloped = overriding(notesApi(doc, rows), (method, path) =>
			method === "GET" && path === "/notes/n1"
				? { body: { data: rows[0], meta: { version: 3 } }, status: 200 }
				: undefined,
		)
		const ctx = await contextOf(optionsFor(enveloped, {}))
		ledgerNotes(ctx, ["n1"])
		expect(await recordTarget(ctx, op(ctx, "notes.update"))).toMatchObject({ current: { id: "n1", title: "here" } })
	})

	it("reads a record back through its entity's read where the probe's own path documents none", async () => {
		const item = { in: "path", name: "note_id", required: true, schema: { type: "string" } }
		const archive = {
			post: {
				operationId: "notes.archive",
				parameters: [item],
				responses: { "200": { description: "ok" } },
				"x-entity": { action: "action", name: "note" },
			},
		}
		const ctx = await contextOf(
			optionsFor(notesApi(notesDoc({ "/notes/{note_id}/archive": archive }), [{ id: "n1", title: "a" }]), {}),
		)
		ledgerNotes(ctx, ["n1"])
		expect(await recordTarget(ctx, op(ctx, "notes.archive"))).toMatchObject({
			current: { id: "n1", title: "a" },
			path: "/notes/n1/archive",
		})
	})

	it("targets a record whose entity documents no read, with no current state and no read sent", async () => {
		const tag = { in: "path", name: "tag_id", required: true, schema: { type: "string" } }
		const remove = {
			delete: {
				operationId: "tags.delete",
				parameters: [tag],
				responses: { "204": { description: "gone" } },
				"x-entity": { action: "delete", name: "tag" },
			},
		}
		const options = optionsFor(notesApi(notesDoc({ "/tags/{tag_id}": remove }), []), {})
		const ctx = await contextOf(options)
		const [id] = listedIds(["t1"])
		ctx.ledger.record({ entity: "tag", id: id as NonNullable<typeof id>, scope: {} }, { id: "alpha" })
		const sent = options.seen.length
		expect(await recordTarget(ctx, op(ctx, "tags.delete"))).toMatchObject({ current: undefined, path: "/tags/t1" })
		expect(options.seen).toHaveLength(sent)
	})
})

/* The read-backs sent so far: the probe GETs. */
const readsOf = (ctx: RunContext): number =>
	ctx.client.transcript.filter((exchange) => exchange.purpose === "probe" && exchange.method === "GET").length
const patch = (ctx: RunContext, path: string, body: unknown) =>
	ctx.client.request("PATCH", path, { as: { principal: "alpha" }, body })

describe("recordTarget: one stage's shared reads", () => {
	it("reads a record once for every operation naming it, and gives each its own copy", async () => {
		const ctx = await running([{ id: "n1", title: "a" }], ["n1"])
		const reads = targetReads()
		const first = await recordTarget(ctx, op(ctx, "notes.update"), reads)
		const second = await recordTarget(ctx, op(ctx, "notes.get"), reads)
		expect(readsOf(ctx)).toBe(1)
		expect([first, second]).toMatchObject([{ current: { title: "a" } }, { current: { title: "a" } }])
		expect((first as { current: unknown }).current).not.toBe((second as { current: unknown }).current)
	})

	it("reads it afresh after a write to it went through, or failed in a way that may have applied", async () => {
		const ctx = await running([{ id: "n1", title: "a" }], ["n1"])
		const reads = targetReads()
		await recordTarget(ctx, op(ctx, "notes.update"), reads)
		await patch(ctx, "/notes/n1", { title: "b" })
		expect(await recordTarget(ctx, op(ctx, "notes.update"), reads)).toMatchObject({ current: { title: "b" } })
		expect(readsOf(ctx)).toBe(2)
	})

	it("keeps sharing it across a refused write to it and a write that names it nowhere", async () => {
		const ctx = await running([{ id: "n1", title: "a" }], ["n1"])
		const reads = targetReads()
		await recordTarget(ctx, op(ctx, "notes.update"), reads)
		expect((await patch(ctx, "/notes/n1", { title: 7 })).status).toBe(422)
		await ctx.client.request("POST", "/notes", { as: { principal: "alpha" }, body: { title: "other" } })
		await recordTarget(ctx, op(ctx, "notes.get"), reads)
		expect(readsOf(ctx)).toBe(1)
	})

	it("reads it afresh after a server error on a write to it, and after a write that names its scope", async () => {
		const rows = [{ id: "n1", title: "a" }]
		const api = overriding(notesApi(notesDoc(), rows), (method, path) => {
			if (method === "PATCH" && path === "/notes/n1") return { status: 503 }
			return method === "POST" && path === "/folders/f9/archive" ? { status: 200 } : undefined
		})
		const ctx = await contextOf(optionsFor(api, {}))
		const [note] = listedIds(["n1"])
		ctx.ledger.record(
			{ entity: "note", id: note as NonNullable<typeof note>, scope: { folder: "f9" } },
			{ id: "alpha" },
		)
		const reads = targetReads()
		await recordTarget(ctx, op(ctx, "notes.update"), reads)
		await patch(ctx, "/notes/n1", { title: "b" })
		await recordTarget(ctx, op(ctx, "notes.update"), reads)
		expect(readsOf(ctx)).toBe(2)
		await ctx.client.request("POST", "/folders/f9/archive", { as: { principal: "alpha", scheme: "bearer" } })
		await recordTarget(ctx, op(ctx, "notes.update"), reads)
		expect(readsOf(ctx)).toBe(3)
	})
})
