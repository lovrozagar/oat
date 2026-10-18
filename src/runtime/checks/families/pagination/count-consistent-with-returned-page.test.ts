import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { countIsConsistentWithPage } from "./count-consistent-with-returned-page.ts"
import { listDoc, pagedBackend, stage, widgets } from "./__fixtures__/paged.ts"

const doc = listDoc({ envelope: ["total", "hasMore"], params: ["limit"] })
const rows = widgets(3)

describe("count.consistent-with-returned-page", () => {
	it("applies once there is a record", () => {
		expect(countIsConsistentWithPage.plan(stage(doc, pagedBackend([]), rows).ctx).ok).toBe(true)
		expect(countIsConsistentWithPage.plan(stage(doc, pagedBackend([]), []).ctx).ok).toBe(false)
	})

	it("passes a total at least the size of the page, reading the largest page", async () => {
		const { ctx, findings, sent } = stage(doc, pagedBackend(rows), rows)
		expect(await runCheck(countIsConsistentWithPage, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.options.query)).toEqual([{ limit: 100 }])
		expect(findings.findings).toEqual([])
	})

	it("reports a total smaller than the records returned beside it", async () => {
		const { ctx, findings } = stage(
			doc,
			pagedBackend(rows, (body) => ({ body: { ...body, total: 0 }, status: 200 })),
			rows,
		)
		expect(await runCheck(countIsConsistentWithPage, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("reported count is smaller than the number of records returned")
		expect(findings.findings[0]?.detail).toMatch(
			/^the response carries count=0 while returning 3 record\(s\) in the same body\. /,
		)
	})

	it("names a hasMore=true beside the contradicted total", async () => {
		const lying = pagedBackend(rows, (body) => ({ body: { ...body, hasMore: true, total: 1 }, status: 200 }))
		const { ctx, findings } = stage(doc, lying, rows)
		await runCheck(countIsConsistentWithPage, ctx)
		expect(findings.findings[0]?.detail).toMatch(/in the same body and hasMore=true\. /)
	})

	it("stands down when the listing reports no total", async () => {
		const bare = listDoc({ params: ["limit"] })
		expect(await runCheck(countIsConsistentWithPage, stage(bare, pagedBackend(rows), rows).ctx)).toEqual({
			kind: "stood-down",
			reason: "the listing reports no total",
		})
	})

	it("cannot judge a rejected or empty listing", async () => {
		expect(await runCheck(countIsConsistentWithPage, stage(doc, () => ({ status: 400 }), rows).ctx)).toEqual({
			kind: "unresolved",
			reason: "the listing was rejected",
		})
		expect(await runCheck(countIsConsistentWithPage, stage(doc, pagedBackend([]), rows).ctx)).toEqual({
			kind: "unresolved",
			reason: "the listing returned nothing to count",
		})
	})
})
