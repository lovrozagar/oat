import { describe, expect, it } from "vitest"
import type { Answer } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { listDoc, pagedBackend, queryOf, stage, widgets } from "./__fixtures__/paged.ts"
import { limitBoundsEnforced } from "./pagination-limit-bounds-enforced.ts"

const doc = listDoc({ params: ["limit"], "x-query": { limitOutOfRange: "reject", maxLimit: 3 } })
const rows = widgets(3)

/** Answers a page size of 0 with `zero` and anything else with `over`. */
function bySize(zero: Answer, over: Answer) {
	return (_m: string, _p: string, options: Parameters<typeof queryOf>[0]): Answer =>
		queryOf(options)["limit"] === 0 ? zero : over
}

describe("pagination.limit-bounds-enforced", () => {
	it("applies only where the document declares out-of-range page sizes refused, with a maximum", () => {
		expect(limitBoundsEnforced.plan(stage(doc, pagedBackend([]), rows).ctx)).toEqual({
			ok: true,
			value: { limitParam: "limit", max: 3 },
		})
		const clamp = listDoc({ params: ["limit"], "x-query": { limitOutOfRange: "clamp", maxLimit: 3 } })
		expect(limitBoundsEnforced.plan(stage(clamp, pagedBackend([]), rows).ctx)).toEqual({
			needs: "a declared limitOutOfRange: reject",
			ok: false,
		})
		const noMax = listDoc({ params: ["limit"], "x-query": { limitOutOfRange: "reject" } })
		expect(limitBoundsEnforced.plan(stage(noMax, pagedBackend([]), rows).ctx)).toEqual({
			needs: "a page-size parameter with a maximum",
			ok: false,
		})
		const noLimit = listDoc({ params: [], "x-query": { limitOutOfRange: "reject", maxLimit: 3 } })
		expect(limitBoundsEnforced.plan(stage(noLimit, pagedBackend([]), rows).ctx).ok).toBe(false)
	})

	it("passes a backend that refuses a page size of zero and one past the maximum", async () => {
		const { ctx, findings, sent } = stage(doc, () => ({ status: 400 }), rows)
		expect(await runCheck(limitBoundsEnforced, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => s.options.query)).toEqual([{ limit: 0 }, { limit: 4 }])
		expect(findings.findings).toEqual([])
	})

	it("reports an out-of-range page size that crashes the listing", async () => {
		const { ctx, findings, sent } = stage(doc, () => ({ status: 500 }), rows)
		expect(await runCheck(limitBoundsEnforced, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("an out-of-range page size produces a server error")
		expect(findings.findings[0]?.detail).toBe("limit=0 returned 500; a refused input should be 4xx.")
		expect(sent).toHaveLength(1)
	})

	it("reports an out-of-range page size that is served", async () => {
		const { ctx, findings } = stage(doc, bySize({ status: 400 }, { body: { items: rows }, status: 200 }), rows)
		expect(await runCheck(limitBoundsEnforced, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("an out-of-range page size is served")
		expect(findings.findings[0]?.detail).toMatch(/^limit=4 returned 200; .* outside 1\.\.3 is refused\.$/)
	})

	it("records the first probe turned away for another reason as inconclusive, and stops", async () => {
		const { ctx, findings, sent } = stage(doc, () => ({ status: 401 }), rows)
		await runCheck(limitBoundsEnforced, ctx)
		expect(findings.inconclusive).toHaveLength(1)
		expect(sent).toHaveLength(1)
		expect(findings.findings).toEqual([])
	})

	/* A 401 or 403 tells nothing about the bound: the check must not go on to assert it. */
	it("does not assert the bound when every probe was turned away for another reason", async () => {
		const { ctx } = stage(doc, () => ({ status: 401 }), rows)
		expect((await runCheck(limitBoundsEnforced, ctx)).kind).toBe("unresolved")
	})
})
