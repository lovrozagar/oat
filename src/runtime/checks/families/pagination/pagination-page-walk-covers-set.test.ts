import { describe, expect, it } from "vitest"
import type { Answer, Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { listDoc, page, pagedBackend, queryOf, stage, widgets } from "./__fixtures__/paged.ts"
import { pageWalkCoversSet } from "./pagination-page-walk-covers-set.ts"

const doc = listDoc({ params: ["limit", "page", "sort"] })
const rows = widgets(5)
const unsorted = listDoc({ params: ["limit", "page"] })

/** A backend whose walks at two per page go through `walk(n, body, query)`, n counting from 1. */
function walks(edit: (n: number, body: ReturnType<typeof page>, query: Record<string, unknown>) => Answer): Responder {
	let n = 0
	return pagedBackend(rows, (body, query) => {
		if (query["limit"] !== 2) return { body, status: 200 }
		if (query["page"] === 1) n += 1
		return edit(n, body, query)
	})
}

/** Two per page, starting one record late past the first page. */
function offByOne(body: ReturnType<typeof page>, query: Record<string, unknown>): Answer {
	if (query["page"] === 1) return { body, status: 200 }
	return {
		body: page(rows, { ...query, page: undefined, offset: ((query["page"] as number) - 1) * 2 + 1 }),
		status: 200,
	}
}

describe("pagination.page-walk-covers-set", () => {
	it("applies to a pageable or cursor listing with more than two records", () => {
		expect(pageWalkCoversSet.plan(stage(doc, pagedBackend([]), rows).ctx).ok).toBe(true)
		expect(pageWalkCoversSet.plan(stage(doc, pagedBackend([]), widgets(2)).ctx).ok).toBe(false)
		const cursor = listDoc({ envelope: ["nextCursor"], params: ["limit", "cursor"] })
		expect(pageWalkCoversSet.plan(stage(cursor, pagedBackend([]), rows).ctx).ok).toBe(true)
		expect(pageWalkCoversSet.plan(stage(listDoc({ params: ["limit"] }), pagedBackend([]), rows).ctx).ok).toBe(false)
	})

	it("passes two walks at two per page, under a sort with ties, that reproduce the whole set", async () => {
		const { ctx, findings, sent } = stage(doc, pagedBackend(rows), rows)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "asserted" })
		expect(queryOf(sent[0]!.options)).toEqual({ limit: 100, page: 1, sort: "tag.asc" })
		expect(sent.filter((s) => queryOf(s.options)["limit"] === 2 && queryOf(s.options)["page"] === 1)).toHaveLength(2)
		expect(findings.findings).toEqual([])
	})

	it("walks unsorted where nothing can be sorted by", async () => {
		const { ctx, sent } = stage(unsorted, pagedBackend(rows), rows)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "asserted" })
		expect(queryOf(sent[0]!.options)).toEqual({ limit: 100, page: 1 })
	})

	it("grows the page so a large collection is walked to its end within the page cap", async () => {
		const many = widgets(23)
		const { ctx, sent } = stage(doc, pagedBackend(many), many)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "asserted" })
		expect(sent.some((s) => queryOf(s.options)["limit"] === 5)).toBe(true)
	})
})

describe("pagination.page-walk-covers-set: walks that drop or repeat records", () => {
	it("reports a record served on more than one page", async () => {
		const stuck = walks((_n, body) => ({
			body: { ...body, items: page(rows, { limit: 2, sort: "tag.asc" }).items },
			status: 200,
		}))
		const { ctx, findings } = stage(doc, stuck, rows)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("paging returns the same record on more than one page")
		expect(findings.findings[0]?.detail).toMatch(/^walking at limit=2 returned 2 duplicated id\(s\): w01, w03\. /)
		expect(findings.findings[0]?.evidence[0]?.url).toBe("http://api.test/widgets")
	})

	it("reports a walk that skips records a single page returns", async () => {
		const { ctx, findings } = stage(
			doc,
			walks((_n, body, query) => offByOne(body, query)),
			rows,
		)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("paging skips records that a single large page returns")
		expect(findings.findings[0]?.detail).toBe(
			"a single page at limit=100 returned 5 records, but walking at limit=2 yielded 4 and missed 1: w05",
		)
	})

	it("reports two identical walks that order the records differently", async () => {
		const swap = walks((n, body) => ({
			body: { ...body, items: n === 2 ? body.items.toReversed() : body.items },
			status: 200,
		}))
		const { ctx, findings } = stage(doc, swap, rows)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("identical page walks return records in different orders")
		expect(findings.findings[0]?.detail).toMatch(
			/^walking the collection twice with the same parameters \(order=tag\.asc\) produced the same records in a different order\. /,
		)
	})

	it("reports two identical walks that hold different records", async () => {
		const drift = walks((n, body, query) => (n === 2 ? offByOne(body, query) : { body, status: 200 }))
		const { ctx, findings } = stage(unsorted, drift, rows)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("identical page walks return different records")
		expect(findings.findings[0]?.detail).toMatch(
			/^walking the collection twice with the same parameters produced different sets\. /,
		)
	})
})

describe("pagination.page-walk-covers-set: walks that cannot see the whole set", () => {
	it("does not count records past the page cap as missing", async () => {
		/* At two per page the backend never ends, so the walk stops at the cap short of the set. */
		const endless = pagedBackend(rows, (body, query) => {
			if (query["limit"] !== 2) return { body, status: 200 }
			const start = ((query["page"] as number) - 1) * 2
			return {
				body: {
					items: [
						{ id: `x${start}`, tag: "t0" },
						{ id: `x${start + 1}`, tag: "t0" },
					],
				},
				status: 200,
			}
		})
		const { ctx, findings } = stage(doc, endless, rows)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("does not count records as missing when the whole set could not be read", async () => {
		const refused = pagedBackend(rows, (body, query) =>
			query["limit"] === 2 ? { body, status: 200 } : { status: 400 },
		)
		const { ctx, findings } = stage(doc, refused, rows)
		expect(await runCheck(pageWalkCoversSet, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})
})
