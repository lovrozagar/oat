import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { listDoc, pagedBackend, stage, widgets } from "./__fixtures__/paged.ts"
import { limitBoundsPageSize } from "./pagination-limit-bounds-page-size.ts"

const doc = listDoc({ params: ["limit"] })

describe("pagination.limit-bounds-page-size", () => {
	it("applies only with a page-size parameter and more than two records", () => {
		expect(limitBoundsPageSize.plan(stage(doc, pagedBackend([]), widgets(3)).ctx).ok).toBe(true)
		expect(limitBoundsPageSize.plan(stage(doc, pagedBackend([]), widgets(2)).ctx).ok).toBe(false)
		expect(limitBoundsPageSize.plan(stage(listDoc({ params: [] }), pagedBackend([]), widgets(3)).ctx).ok).toBe(false)
	})

	it("passes a backend that serves at most the two records asked for", async () => {
		const { ctx, findings, sent } = stage(doc, pagedBackend(widgets(5)), widgets(5))
		expect(await runCheck(limitBoundsPageSize, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.options.query)).toEqual([{ limit: 2 }])
		expect(findings.findings).toEqual([])
	})

	it("reports a backend that ignores the page size", async () => {
		const rows = widgets(5)
		const { ctx, findings } = stage(
			doc,
			pagedBackend(rows, (body) => ({ body: { ...body, items: rows }, status: 200 })),
			rows,
		)
		expect(await runCheck(limitBoundsPageSize, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("limit does not bound the number of records returned")
		expect(findings.findings[0]?.detail).toMatch(/limit=2 returned 5 records/)
	})

	it("cannot judge a listing that was rejected", async () => {
		const { ctx, findings } = stage(doc, () => ({ status: 400 }), widgets(5))
		expect(await runCheck(limitBoundsPageSize, ctx)).toEqual({ kind: "unresolved", reason: "the listing was rejected" })
		expect(findings.findings).toEqual([])
	})
})
