import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { listDoc, pagedBackend, stage, widgets } from "./__fixtures__/paged.ts"
import { limitRespectsMax } from "./pagination-limit-respects-documented-max.ts"

const doc = listDoc({ params: ["limit"], "x-query": { maxLimit: 3 } })
const rows = widgets(5)

describe("pagination.limit-respects-documented-max", () => {
	it("applies only with a documented maximum, a page-size parameter and more records than the cap", () => {
		expect(limitRespectsMax.plan(stage(doc, pagedBackend([]), rows).ctx)).toEqual({
			ok: true,
			value: { limitParam: "limit", max: 3 },
		})
		expect(limitRespectsMax.plan(stage(doc, pagedBackend([]), widgets(3)).ctx).ok).toBe(false)
		expect(limitRespectsMax.plan(stage(listDoc({ params: ["limit"] }), pagedBackend([]), rows).ctx).ok).toBe(false)
		const noLimit = listDoc({ params: [], "x-query": { maxLimit: 3 } })
		expect(limitRespectsMax.plan(stage(noLimit, pagedBackend([]), rows).ctx).ok).toBe(false)
	})

	it("passes a backend that clamps a page size past the cap", async () => {
		const clamp = pagedBackend(rows, (body) => ({ body: { ...body, items: body.items.slice(0, 3) }, status: 200 }))
		const { ctx, findings, sent } = stage(doc, clamp, rows)
		expect(await runCheck(limitRespectsMax, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.options.query)).toEqual([{ limit: 53 }])
		expect(findings.findings).toEqual([])
	})

	it("passes a backend that refuses a page size past the cap", async () => {
		const { ctx } = stage(doc, () => ({ status: 422 }), rows)
		expect(await runCheck(limitRespectsMax, ctx)).toEqual({ kind: "asserted" })
	})

	it("reports a backend that serves more records than the cap", async () => {
		const { ctx, findings } = stage(doc, pagedBackend(rows), rows)
		expect(await runCheck(limitRespectsMax, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("page size exceeds the documented maximum")
		expect(findings.findings[0]?.detail).toMatch(/limit=53 returned 5 records; the document caps limit at 3/)
	})

	it("cannot judge a probe turned away for another reason", async () => {
		const { ctx, findings } = stage(doc, () => ({ status: 401 }), rows)
		expect((await runCheck(limitRespectsMax, ctx)).kind).toBe("unresolved")
		expect(findings.findings).toEqual([])
	})
})
