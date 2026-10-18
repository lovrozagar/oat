import { describe, expect, it } from "vitest"
import type { QueryCapability } from "../../../../spec/extensions/query-tag.ts"
import type { Responder } from "../../__fixtures__/harness.ts"
import { resolvedCaps } from "../../query/capabilities.ts"
import { backend, NOTES, PARAMS, queryDoc, stage } from "../composition/__fixtures__/query-api.ts"
import { growing, ignoring, LATECOMER, refusingAfter, refusingOrder } from "./__fixtures__/sort-api.ts"
import { sortDefaultOrderApplied } from "./sort-default-order-applied.ts"

/* The cohort is served in insertion order, which is id ascending. */
const declaring = (defaultOrder: string) => queryDoc({ sort: { defaultOrder } })

/* Serves one more record whenever an order is given, on every read alike. */
const widerWhenOrdered: Responder = (method, path, options) =>
	backend(options.query?.order === undefined ? NOTES : [...NOTES, LATECOMER])(method, path, options)

describe("sort.default-order-applied judges", () => {
	it("passes a listing whose implicit order is the declared default", async () => {
		const staged = stage(sortDefaultOrderApplied, { doc: declaring("id.asc") })
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query?.order)).toEqual([undefined, "id.asc"])
	})

	it("fails a listing that ignores its declared default order", async () => {
		const staged = stage(sortDefaultOrderApplied, { doc: declaring("rank.desc") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.findings.findings[0]).toMatchObject({
			check: "sort.default-order-applied",
			detail: "defaultOrder=rank.desc produced a different sequence than the implicit listing.",
			summary: "omitting order does not match defaultOrder",
		})
	})

	it("fails, after reading both again, when an explicit order holds a record the implicit one lacks", async () => {
		const staged = stage(sortDefaultOrderApplied, { doc: declaring("id.asc"), respond: widerWhenOrdered })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(staged.sent).toHaveLength(4)
	})
})

describe("sort.default-order-applied gives up", () => {
	it("is unresolved when the explicit default order is refused", async () => {
		const staged = stage(sortDefaultOrderApplied, { doc: declaring("id.asc"), respond: refusingOrder("id.asc") })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "default-order walk was rejected" })
	})

	it("is unresolved when the collection grows between the two reads", async () => {
		const staged = stage(sortDefaultOrderApplied, { doc: declaring("id.asc"), respond: growing(1) })
		expect(await staged.run()).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("gained or lost") })
	})

	it("is unresolved when a repeat read is refused", async () => {
		const staged = stage(sortDefaultOrderApplied, { doc: declaring("id.asc"), respond: refusingAfter(2, growing(1)) })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "default-order walk was rejected" })
	})

	it("is unresolved when the walk cannot show the set ended", async () => {
		const doc = queryDoc({ sort: { defaultOrder: "id.asc" } }, [...PARAMS, "page"])
		const staged = stage(sortDefaultOrderApplied, { doc, respond: ignoring("page") })
		expect(await staged.run()).toEqual({
			kind: "unresolved",
			reason: "the walk is incomplete, so default order cannot be compared",
		})
	})
})

describe("sort.default-order-applied plans", () => {
	it("reads the default order from the query tag when the capabilities carry none", () => {
		const base = stage(sortDefaultOrderApplied)
		const query = { ...base.ctx.query, defaultOrder: "title.asc" } as QueryCapability
		const staged = stage(sortDefaultOrderApplied, { fields: { capabilities: resolvedCaps(base.ctx), query } })
		expect(staged.plan()).toEqual({ ok: true, value: { defaultOrder: "title.asc" } })
	})

	it("stands down without a declared default or with one record", async () => {
		expect(stage(sortDefaultOrderApplied).plan().ok).toBe(false)
		const lone = stage(sortDefaultOrderApplied, { doc: declaring("id.asc"), rows: NOTES.slice(0, 1) })
		expect(await lone.run()).toEqual({ kind: "stood-down", reason: "a declared defaultOrder and a complete walk" })
		expect(lone.sent).toEqual([])
	})
})
