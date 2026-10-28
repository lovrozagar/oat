import { describe, expect, it } from "vitest"
import type { Exchange } from "../../../exchange.ts"
import { contextFor } from "../../__fixtures__/harness.ts"
import { readSchemaHonored } from "./schema-read-response-matches-document.ts"
import {
	ITEM,
	type ItemsOptions,
	UNCOMPILABLE,
	itemOperations,
	modelOfItems,
	overTranscript,
	seen,
} from "./__fixtures__/items.ts"

/*
 * Every 2xx answer of an entity's item read and listing must fit the schema the document declares
 * for its status. The check judges the answers the run already drew; it sends nothing.
 */

const ROW = { id: "1", name: "a" }

/** The check's outcome over a transcript of `exchanges`, and the operations it says it judged. */
async function judge(exchanges: Exchange[], options: ItemsOptions = {}) {
	const judged: string[][] = []
	const staged = overTranscript(modelOfItems(options), exchanges, {
		fields: { judged: (ids: readonly string[]) => judged.push([...ids]) },
	})
	const plan = readSchemaHonored.plan(staged.ctx)
	if (!plan.ok) throw new Error("the read-schema plan did not apply")
	return { ...staged, judged, outcome: await readSchemaHonored.run(staged.ctx, plan.value) }
}

const listed = (body: unknown, extra: Partial<Exchange> = {}): Exchange =>
	seen("item.list", { body, status: 200 }, { url: "http://api.test/items", ...extra })

describe("schema.read-response-matches-document plan", () => {
	it("needs a validator, and an item read or a listing", () => {
		const model = modelOfItems()
		const { ctx } = contextFor(model, "item.list", { respond: () => undefined, fields: itemOperations(model) })
		expect(readSchemaHonored.plan(ctx).ok).toBe(true)
		expect(readSchemaHonored.plan({ ...ctx, readOp: undefined }).ok).toBe(true)
		expect(readSchemaHonored.plan({ ...ctx, validator: undefined }).ok).toBe(false)
		const bare = { ...ctx, listOp: undefined, readOp: undefined } as unknown as typeof ctx
		expect(readSchemaHonored.plan(bare).ok).toBe(false)
	})
})

describe("schema.read-response-matches-document run", () => {
	it("asserts when every read and listing answer fits its documented schema", async () => {
		const { findings, judged, outcome } = await judge([seen("item.read", { body: ROW, status: 200 }), listed([ROW])])
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
		expect(judged).toEqual([["item.read", "item.list"]])
	})

	it("reports a read that answers the record under another key than documented, as a spec bug", async () => {
		const { findings, outcome } = await judge([seen("item.read", { body: { item: ROW }, status: 200 })])
		expect(outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		const [finding] = findings.findings
		expect(finding).toMatchObject({
			check: "schema.read-response-matches-document",
			operations: ["item.read"],
			summary: "item.read answered a body its documented schema does not describe",
			verdict: "SPEC_BUG",
		})
		expect(finding?.detail).toContain("item.read returned 200 with a body that fails the declared schema")
		expect(finding?.detail).toContain("must have required property 'id'")
		expect(finding?.evidence.map((e) => e.status)).toEqual([200])
	})

	it("holds the schema as written: an extra member passes an open schema and fails a closed one", async () => {
		const { additionalProperties: _closed, ...open } = ITEM
		const extra = seen("item.read", { body: { extra: 1, ...ROW }, status: 200 })
		expect((await judge([extra], { read: open })).outcome).toEqual({ kind: "asserted" })
		expect((await judge([extra])).outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
	})

	it("reports each operation once, on its first diverging answer", async () => {
		const first = seen("item.read", { body: { extra: 1, ...ROW }, status: 200 })
		const { findings } = await judge([
			first,
			seen("item.read", { body: { other: 2, ...ROW }, status: 200 }),
			listed([{ id: 1, name: "a" }]),
		])
		expect(findings.findings.map((f) => f.operations)).toEqual([["item.read"], ["item.list"]])
		expect(findings.findings[0]?.evidence).toEqual([first])
	})
})

describe("schema.read-response-matches-document, what it leaves alone", () => {
	it("leaves alone what is not a documented 2xx answer to an ordinary read", async () => {
		const wrong = { body: { item: ROW }, status: 200 }
		const { findings, outcome } = await judge([
			seen("item.read", { body: ROW, status: 200 }),
			seen("item.read", { body: { nope: 1 }, status: 404 }),
			seen("item.read", { status: 0 }),
			seen("item.read", wrong, { probe: true }),
			seen("item.read", wrong, { superseded: true }),
			seen("item.update", wrong),
			seen("other.list", wrong),
		])
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("leaves alone an event stream, and a read the document no longer holds", async () => {
		const wrong = { body: { item: ROW }, status: 200 }
		const stream = seen("item.read", wrong, { responseHeaders: { "content-type": "text/event-stream" } })
		const streamed = await judge([stream, listed([ROW])])
		expect(streamed.outcome).toEqual({ kind: "asserted" })
		expect(streamed.judged).toEqual([["item.list"]])
		const staged = overTranscript(modelOfItems(), [seen("item.read", wrong), listed([ROW])])
		staged.model.rawOperations.delete("item.read")
		const plan = readSchemaHonored.plan(staged.ctx)
		if (!plan.ok) throw new Error("the read-schema plan did not apply")
		expect(await readSchemaHonored.run(staged.ctx, plan.value)).toEqual({ kind: "asserted" })
		expect(staged.findings.findings).toEqual([])
	})
})

describe("schema.read-response-matches-document, what it cannot see", () => {
	it("judges a page held only by reference by the verdict taken at capture, and one without it not at all", async () => {
		const ref = { bytes: 300_000, mediaType: "application/json", sha256: "a".repeat(64) }
		const drifted = listed(ref, { schemaVerdict: { errors: ["/0/name must be string"] } })
		const { findings, judged, outcome } = await judge([drifted, listed([ROW])])
		expect(outcome).toEqual({ kind: "finding", verdict: "SPEC_BUG" })
		expect(findings.findings.map((f) => [f.operations, f.detail.includes("/0/name must be string")])).toEqual([
			[["item.list"], true],
		])
		expect(judged).toEqual([["item.list"]])
		/* Held to its schema and fitting it: a pass, with nothing said about its size. */
		expect((await judge([listed(ref, { schemaVerdict: { errors: [] } })])).outcome).toEqual({ kind: "asserted" })
		/* Never captured whole, there is nothing to judge it by. */
		const unjudged = await judge([listed(ref)])
		expect(unjudged.outcome).toEqual({
			kind: "stood-down",
			reason: "a 2xx answer of this entity's item read or listing",
		})
	})

	it("leaves alone a listing asked for a sparse fieldset, which answers less than the record", async () => {
		const sparse = listed([{ name: "a" }], { url: "http://api.test/items?select=name" })
		const bracketed = listed([{ name: "a" }], { url: "http://api.test/items?select%5Bitems%5D=name" })
		const { findings, outcome } = await judge([sparse, bracketed, listed([ROW])], { select: true })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("stands down when the run drew no 2xx read or listing answer", async () => {
		const { outcome } = await judge([seen("item.read", { status: 404 })])
		expect(outcome).toEqual({ kind: "stood-down", reason: "a 2xx answer of this entity's item read or listing" })
	})

	it("reports a documented schema it cannot compile as a gap, not a pass", async () => {
		const { findings, outcome } = await judge([seen("item.read", { body: ROW, status: 200 })], { read: UNCOMPILABLE })
		expect(outcome).toEqual({ kind: "asserted" })
		expect(findings.findings.map((f) => [f.verdict, f.operations, f.summary])).toEqual([
			["COVERAGE_GAP", ["item.read"], "item.read 200 has a schema that cannot be compiled"],
		])
	})
})
