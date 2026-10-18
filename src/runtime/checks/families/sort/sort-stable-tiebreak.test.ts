import { describe, expect, it } from "vitest"
import type { QueryCapability } from "../../../../spec/extensions.ts"
import type { Record_ } from "../../../world.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { resolvedCaps } from "../../query/capabilities.ts"
import { applyOrder, NOTES, queryDoc, queryOf, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { growing, refusingAfter } from "./__fixtures__/sort-api.ts"
import { sortStableTiebreak } from "./sort-stable-tiebreak.ts"

const breakingBy = (stableTiebreak: string) => queryDoc({ stableTiebreak })
const byId = breakingBy("id")

/* Sorted by the requested order, the cohort first laid out as `rows`: ties keep that layout. */
const servingAs =
	(rows: readonly Record_[]): Responder =>
	(_method, _path, options) => ({ body: applyOrder(rows, queryOf(options).order ?? ""), status: 200 })

/* Ties on "open" laid out n1, n4, n2: rising, then falling. */
const scrambled = servingAs([NOTES[0], NOTES[3], NOTES[1], NOTES[2], NOTES[4], NOTES[5]] as Record_[])

/* Ties in id order on the first read, reversed on every read after. */
function flipping(): Responder {
	let reads = 0
	return (method, path, options) => {
		reads += 1
		return servingAs(reads === 1 ? NOTES : NOTES.toReversed())(method, path, options)
	}
}

describe("sort.stable-tiebreak judges", () => {
	it("passes ties broken by the declared tiebreak, read twice afresh", async () => {
		const staged = stage(sortStableTiebreak, { doc: byId })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual(["status.asc", "status.asc"])
	})

	it("passes ties broken the other way, and skips null tiebreak values", async () => {
		expect(await stage(sortStableTiebreak, { doc: byId, respond: servingAs(NOTES.toReversed()) }).run()).toEqual({
			kind: "asserted",
		})
		expect(await stage(sortStableTiebreak, { doc: breakingBy("score") }).run()).toEqual({ kind: "asserted" })
	})

	it("passes an empty listing: there are no ties to break", async () => {
		const staged = stage(sortStableTiebreak, { doc: byId, respond: () => ({ body: [], status: 200 }) })
		expect(await staged.run()).toEqual({ kind: "asserted" })
	})

	it("fails ties the declared tiebreak does not explain", async () => {
		const staged = stage(sortStableTiebreak, { doc: byId, respond: scrambled })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			detail: expect.stringContaining('tied on status ("open") in an order the declared stableTiebreak "id"'),
			summary: "ties are not broken by the declared tiebreak",
		})
	})

	it("fails the same order coming back in two sequences", async () => {
		const staged = stage(sortStableTiebreak, { doc: byId, respond: flipping() })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]?.summary).toBe("the same order is not deterministic across two walks")
	})
})

describe("sort.stable-tiebreak gives up", () => {
	it("is unresolved when either read is refused", async () => {
		const reason = { kind: "unresolved", reason: "repeat sort was rejected" }
		expect(await stage(sortStableTiebreak, { doc: byId, respond: () => REJECT }).run()).toEqual(reason)
		expect(await stage(sortStableTiebreak, { doc: byId, respond: refusingAfter(1) }).run()).toEqual(reason)
		expect(await stage(sortStableTiebreak, { doc: byId, respond: refusingAfter(2, growing(1)) }).run()).toEqual(reason)
	})

	it("is unresolved when the collection grows between the reads", async () => {
		const staged = stage(sortStableTiebreak, { doc: byId, respond: growing(1) })
		expect(await staged.run()).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("gained or lost") })
	})
})

describe("sort.stable-tiebreak plans", () => {
	it("reads the tiebreak from the query tag when the capabilities carry none", () => {
		const base = stage(sortStableTiebreak)
		const query = { ...base.ctx.query, stableTiebreak: "rank" } as QueryCapability
		const staged = stage(sortStableTiebreak, { fields: { capabilities: resolvedCaps(base.ctx), query } })
		expect(staged.plan()).toEqual({ ok: true, value: { primary: "status", tiebreak: "rank" } })
	})

	it("stands down without a declared tiebreak", async () => {
		const staged = stage(sortStableTiebreak)
		expect(await staged.run()).toEqual({
			kind: "stood-down",
			reason: "a declared stableTiebreak and a tie on the primary key",
		})
	})

	it("needs a tied field other than the tiebreak itself", () => {
		const needs = { needs: "a sortable field with tied values in the cohort", ok: false }
		const distinct = NOTES.map((row, index) => ({ ...row, rank: index, score: index, status: row.id }))
		expect(stage(sortStableTiebreak, { doc: byId, rows: distinct }).plan()).toEqual(needs)
		expect(stage(sortStableTiebreak, { doc: breakingBy("status") }).plan()).toEqual(needs)
	})
})
