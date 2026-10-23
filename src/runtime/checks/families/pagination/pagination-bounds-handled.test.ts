import { describe, expect, it } from "vitest"
import type { Answer } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { listDoc, pagedBackend, queryOf, stage, widgets } from "./__fixtures__/paged.ts"
import { paginationBoundsHandled } from "./pagination-bounds-handled.ts"

const rows = widgets(3)
const sizeOnly = listDoc({ params: ["limit"] })
const pageOnly = listDoc({ params: ["page"] })
const both = listDoc({ params: ["limit", "page"] })

/** A correct backend whose answer to page `beyond` is `past`. */
function pastTheEnd(past: Answer) {
	return pagedBackend(rows, (body, query) => (query["page"] === 5 ? past : { body, status: 200 }))
}

describe("pagination.bounds-handled", () => {
	it("applies with a page-size or page-number parameter and a record", () => {
		expect(paginationBoundsHandled.plan(stage(both, pagedBackend([]), rows).ctx)).toEqual({
			ok: true,
			value: { limit: "limit", page: "page" },
		})
		expect(paginationBoundsHandled.plan(stage(pageOnly, pagedBackend([]), rows).ctx)).toEqual({
			ok: true,
			value: { limit: undefined, page: "page" },
		})
		expect(paginationBoundsHandled.plan(stage(both, pagedBackend([]), []).ctx).ok).toBe(false)
		expect(paginationBoundsHandled.plan(stage(listDoc({ params: [] }), pagedBackend([]), rows).ctx).ok).toBe(false)
	})

	it("passes refused out-of-range page sizes, probing each", async () => {
		const { ctx, findings, sent } = stage(sizeOnly, () => ({ status: 400 }), rows)
		expect(await runCheck(paginationBoundsHandled, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => queryOf(s.options)["limit"])).toEqual(["0", "-1", "2.5", "abc"])
		expect(findings.findings).toEqual([])
	})

	it("reports a page size that crashes the listing", async () => {
		const crash = (_m: string, _p: string, options: Parameters<typeof queryOf>[0]): Answer =>
			queryOf(options)["limit"] === "2.5" ? { status: 503 } : { body: { items: rows }, status: 200 }
		const { ctx, findings, sent } = stage(sizeOnly, crash, rows)
		expect(await runCheck(paginationBoundsHandled, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("a page size of 2.5 crashes the listing")
		expect(findings.findings[0]?.detail).toMatch(/^\?limit=2\.5 returned 503; /)
		expect(sent).toHaveLength(3)
	})
})

describe("pagination.bounds-handled: a page past the end", () => {
	it("passes a page past the end that is served empty", async () => {
		const { ctx, findings, sent } = stage(both, pagedBackend(rows), rows)
		expect(await runCheck(paginationBoundsHandled, ctx)).toEqual({
			kind: "asserted",
			note: "a page past the end is served empty",
		})
		expect(queryOf(sent.at(-1)!.options)).toEqual({ limit: 100, page: 5 })
		expect(findings.findings).toEqual([])
	})

	it("passes a page past the end that is refused", async () => {
		const { ctx } = stage(pageOnly, pastTheEnd({ status: 404 }), rows)
		expect(await runCheck(paginationBoundsHandled, ctx)).toEqual({
			kind: "asserted",
			note: "a page past the end is refused (404)",
		})
	})

	it("reports a page past the end that crashes the listing", async () => {
		const { ctx, findings } = stage(pageOnly, pastTheEnd({ status: 500 }), rows)
		expect(await runCheck(paginationBoundsHandled, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("a page past the end crashes the listing")
		expect(findings.findings[0]?.detail).toBe("?page=5, past the last of 3 record(s), returned 500.")
	})

	it("reports a page past the end that serves the last page again", async () => {
		const { ctx, findings } = stage(pageOnly, pastTheEnd({ body: { items: rows }, status: 200 }), rows)
		expect(await runCheck(paginationBoundsHandled, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("a page past the end of the collection returns records")
		expect(findings.findings[0]?.detail).toMatch(
			/^\?page=5 lies past the last of 3 record\(s\) at 100 per page, yet returned 3\./,
		)
		expect(findings.findings[0]?.evidence).toHaveLength(2)
	})
})

describe("pagination.bounds-handled: a collection it cannot read whole", () => {
	it("cannot judge a collection it could not read whole", async () => {
		const { ctx } = stage(pageOnly, () => ({ status: 400 }), rows)
		expect(await runCheck(paginationBoundsHandled, ctx)).toEqual({
			kind: "unresolved",
			reason: "page 1 was answered with 400",
		})
		const stuck = stage(
			pageOnly,
			pagedBackend(rows, (body) => ({ body: { ...body, items: rows }, status: 200 })),
			rows,
		)
		expect(await runCheck(paginationBoundsHandled, stuck.ctx)).toEqual({
			kind: "unresolved",
			reason: "pages repeat the same records",
		})
	})
})
