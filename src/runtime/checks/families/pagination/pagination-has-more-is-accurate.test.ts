import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { listDoc, pagedBackend, stage, widgets } from "./__fixtures__/paged.ts"
import { hasMoreIsAccurate } from "./pagination-has-more-is-accurate.ts"

const doc = listDoc({ envelope: ["hasMore"], params: ["limit", "page"] })

describe("pagination.has-more-is-accurate", () => {
	it("applies only to a pageable listing with more than two records", () => {
		expect(hasMoreIsAccurate.plan(stage(doc, pagedBackend([]), widgets(3)).ctx).ok).toBe(true)
		expect(hasMoreIsAccurate.plan(stage(doc, pagedBackend([]), widgets(2)).ctx).ok).toBe(false)
		const cursorOnly = listDoc({ envelope: ["hasMore"], params: ["limit", "cursor"] })
		expect(hasMoreIsAccurate.plan(stage(cursorOnly, pagedBackend([]), widgets(3)).ctx).ok).toBe(false)
	})

	it("passes a flag that says more pages exist when page 2 has records", async () => {
		const { ctx, findings, sent } = stage(doc, pagedBackend(widgets(3)), widgets(3))
		expect(await runCheck(hasMoreIsAccurate, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.options.query)).toEqual([
			{ limit: 1, page: 1 },
			{ limit: 1, page: 2 },
		])
		expect(findings.findings).toEqual([])
	})

	it("passes a flag that says no more pages exist when page 2 is empty", async () => {
		const { ctx } = stage(doc, pagedBackend(widgets(1)), widgets(3))
		expect(await runCheck(hasMoreIsAccurate, ctx)).toEqual({ kind: "asserted" })
	})
})

describe("pagination.has-more-is-accurate: reports a has-more flag the next page contradicts", () => {
	it("reports hasMore=true when the next page is empty", async () => {
		const { ctx, findings } = stage(
			doc,
			pagedBackend(widgets(1), (body) => ({ body: { ...body, hasMore: true }, status: 200 })),
			widgets(3),
		)
		expect(await runCheck(hasMoreIsAccurate, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("hasMore claims further pages exist when none do")
		expect(findings.findings[0]?.detail).toMatch(/request an empty page$/)
		expect(findings.findings[0]?.evidence).toHaveLength(2)
	})

	it("reports hasMore=false while the next page returns records", async () => {
		const { ctx, findings } = stage(
			doc,
			pagedBackend(widgets(3), (body) => ({ body: { ...body, hasMore: false }, status: 200 })),
			widgets(3),
		)
		expect(await runCheck(hasMoreIsAccurate, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("hasMore claims no further pages while the next page returns records")
		expect(findings.findings[0]?.detail).toMatch(/silently stop after the first page$/)
	})

	it("stands down when the listing carries no has-more flag", async () => {
		const bare = listDoc({ params: ["limit", "page"] })
		const { ctx, sent } = stage(bare, pagedBackend(widgets(3)), widgets(3))
		expect(await runCheck(hasMoreIsAccurate, ctx)).toEqual({
			kind: "stood-down",
			reason: "the listing has no has-more flag",
		})
		expect(sent).toHaveLength(1)
	})

	it("cannot judge a first page that is rejected or empty", async () => {
		const unresolved = { kind: "unresolved", reason: "the first page was rejected or empty" }
		expect(await runCheck(hasMoreIsAccurate, stage(doc, () => ({ status: 400 }), widgets(3)).ctx)).toEqual(unresolved)
		expect(await runCheck(hasMoreIsAccurate, stage(doc, pagedBackend([]), widgets(3)).ctx)).toEqual(unresolved)
	})
})
