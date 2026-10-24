import { describe, expect, it } from "vitest"
import type { Exchange } from "../../../exchange.ts"
import type { Listed } from "../../core/context.ts"
import { contextFor } from "../../__fixtures__/harness.ts"
import { writeOnlyNotReturned } from "./response-write-only-not-returned.ts"
import { itemOperations, type ItemsOptions, modelOfItems, overTranscript, seen, unnamed } from "./__fixtures__/items.ts"

/*
 * A property the document marks writeOnly is never sent back (OAS 3: "relevant only for request
 * messages"), whatever additionalProperties says: an open schema accepts a leaked secret, and this
 * check still reports it. The answers judged are the ones the run drew; nothing is sent.
 */

/* An open record: a password, a nickname the client sets and never reads, and its own fields. */
const OPEN = {
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		nickname: { type: "string", writeOnly: true },
		password: { format: "password", type: "string", writeOnly: true },
	},
	required: ["id", "name"],
	type: "object",
}
const RECORD: ItemsOptions = { record: OPEN }
const ROW = { id: "1", name: "a" }

async function judge(exchanges: Exchange[], options: ItemsOptions = RECORD, fields: Partial<Listed> = {}) {
	const judged: string[][] = []
	const staged = overTranscript(modelOfItems(options), exchanges, {
		fields: { judged: (ids: readonly string[]) => judged.push([...ids]), ...fields },
	})
	const plan = writeOnlyNotReturned.plan(staged.ctx)
	if (!plan.ok) throw new Error("the write-only plan did not apply")
	return { ...staged, judged, outcome: await writeOnlyNotReturned.run(staged.ctx, plan.value) }
}

const read = (body: unknown, extra: Partial<Exchange> = {}) => seen("item.read", { body, status: 200 }, extra)
const listed = (body: unknown) => seen("item.list", { body, status: 200 }, { url: "http://api.test/items" })
const created = (body: unknown) => seen("item.create", { body, status: 201 })

describe("response.write-only-not-returned plan", () => {
	it("needs a property the record's schema or a write's body marks writeOnly", () => {
		const model = modelOfItems(RECORD)
		const { ctx } = contextFor(model, "item.list", { respond: () => undefined, fields: itemOperations(model) })
		const planned = writeOnlyNotReturned.plan(ctx)
		expect(planned.ok && [...planned.value.fields.keys()].toSorted()).toEqual(["nickname", "password"])
		const plain = modelOfItems()
		const bare = contextFor(plain, "item.list", { respond: () => undefined, fields: itemOperations(plain) })
		expect(writeOnlyNotReturned.plan(bare.ctx).ok).toBe(false)
	})

	it("reads a write's body for writeOnly fields though the record's schema declares none, and grades the read and the listing", () => {
		const model = modelOfItems({ record: OPEN, read: { properties: { id: { type: "string" } }, type: "object" } })
		const { ctx } = contextFor(model, "item.list", { respond: () => undefined, fields: itemOperations(model) })
		const narrow = { ...ctx, listOp: undefined, updateOp: undefined } as unknown as typeof ctx
		/* The read answers no writeOnly field; the create's body declares both, and the read is there to judge. */
		const planned = writeOnlyNotReturned.plan(narrow)
		expect(planned.ok && [...planned.value.fields.keys()].toSorted()).toEqual(["nickname", "password"])
		const entity = model.entities.get("item")
		if (entity === undefined) throw new Error("the items document has an item entity")
		expect(writeOnlyNotReturned.subjects(entity, model).toSorted()).toEqual(["item.list", "item.read"])
	})
})

describe("response.write-only-not-returned scope", () => {
	it("does not apply to an entity with neither an item read nor a listing", () => {
		const model = modelOfItems(RECORD)
		const { ctx } = contextFor(model, "item.list", { respond: () => undefined, fields: itemOperations(model) })
		const writesOnly = { ...ctx, listOp: undefined, readOp: undefined } as unknown as typeof ctx
		expect(writeOnlyNotReturned.plan(writesOnly).ok).toBe(false)
	})
})

describe("response.write-only-not-returned run", () => {
	it("reports a secret-like writeOnly field an open schema let through as a security finding", async () => {
		const leak = read({ ...ROW, password: "hunter2" })
		const { findings, outcome } = await judge([leak])
		expect(outcome).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]).toMatchObject({
			check: "response.write-only-not-returned",
			operations: ["item.read"],
			summary: "item.read answered a field the document marks writeOnly: password",
			verdict: "SECURITY",
		})
		expect(findings.findings[0]?.evidence).toEqual([leak])
	})

	it("reports a writeOnly field that is not secret-like as a spec bug, per operation, listing rows included", async () => {
		const { findings } = await judge([
			listed([ROW, { ...ROW, id: "2", nickname: "al" }]),
			read({ ...ROW, nickname: "al" }),
		])
		expect(findings.findings.map((f) => [f.verdict, f.operations])).toEqual([
			["SPEC_BUG", ["item.list"]],
			["SPEC_BUG", ["item.read"]],
		])
	})

	it("leaves the create's own answer alone: a key or secret is handed back once to the caller who made it", async () => {
		const once = await judge([created({ ...ROW, password: "generated" }), read(ROW)])
		expect(once.findings.findings).toEqual([])
		expect(once.judged).toEqual([["item.read"]])
		const later = await judge([created({ ...ROW, password: "generated" }), read({ ...ROW, password: "generated" })])
		expect(later.findings.findings.map((f) => [f.verdict, f.operations])).toEqual([["SECURITY", ["item.read"]]])
	})

	it("asserts when no answer holds a writeOnly field, and stands down when none was drawn", async () => {
		const clean = await judge([read(ROW), read({ ...ROW, password: null }), listed([ROW])])
		expect(clean.outcome).toEqual({ kind: "asserted" })
		expect(clean.judged).toEqual([["item.read", "item.list"]])
		expect((await judge([seen("item.read", { status: 404 })])).outcome).toEqual({
			kind: "stood-down",
			reason: "a 2xx answer of this entity's item read or listing",
		})
	})
})

describe("response.write-only-not-returned, what it leaves alone", () => {
	it("leaves alone what is not an ordinary 2xx answer of this entity's item read or listing", async () => {
		const leaked = { ...ROW, password: "hunter2" }
		const { findings } = await judge([
			read(ROW),
			seen("item.read", { body: leaked, status: 404 }),
			read(leaked, { superseded: true }),
			seen("other.list", { body: [leaked], status: 200 }),
			read({ bytes: 300_000, mediaType: "application/json", sha256: "a".repeat(64) }),
			unnamed({ body: leaked, status: 200 }),
			read(["not", "a", "record"]),
		])
		expect(findings.findings).toEqual([])
		const ungraded = await judge([read({ ...ROW, password: "hunter2" }), listed([ROW])], RECORD, {
			inScope: (op) => op.operationId !== "item.read",
		})
		expect(ungraded.findings.findings).toEqual([])
	})
})
