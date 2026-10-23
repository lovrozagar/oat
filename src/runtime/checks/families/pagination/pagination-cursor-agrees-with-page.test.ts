import { describe, expect, it } from "vitest"
import type { Answer, Responder } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import type { Record_ } from "../../../world/records.ts"
import { type ListDoc, listDoc, page, pagedBackend, queryOf, stage, widgets } from "./__fixtures__/paged.ts"
import { cursorAgreesWithPage } from "./pagination-cursor-agrees-with-page.ts"

const spec: ListDoc = { envelope: ["nextCursor"], params: ["limit", "page", "cursor", "sort"] }
const doc = listDoc(spec)
const rows = widgets(5)

/** The cursor walk's answers go through `edit`; the page walk is served correctly. */
function byCursor(all: Record_[], edit: (query: Record<string, unknown>) => Answer): Responder {
	return pagedBackend(all, (body, query) => (query["page"] === undefined ? edit(query) : { body, status: 200 }))
}

/** Pages from `cursor + shift`: a cursor that resolves to the wrong boundary. */
function shifted(all: Record_[], shift: number, extra: Record_[] = []) {
	return (query: Record<string, unknown>): Answer => {
		const cursor = query["cursor"] === undefined ? undefined : String(Number(query["cursor"]) + shift)
		const body = page(all, { ...query, cursor })
		return { body: { ...body, items: [...extra, ...body.items] }, status: 200 }
	}
}

const idsOnly = (all: Record_[]): Record_[] => all.map((row) => ({ id: row["id"] }))

describe("pagination.cursor-agrees-with-page", () => {
	it("applies with both a cursor and a page parameter, and more than two records", () => {
		expect(cursorAgreesWithPage.plan(stage(doc, pagedBackend([]), rows).ctx).ok).toBe(true)
		expect(cursorAgreesWithPage.plan(stage(doc, pagedBackend([]), widgets(2)).ctx).ok).toBe(false)
		const noCursor = listDoc({ ...spec, params: ["limit", "page"] })
		expect(cursorAgreesWithPage.plan(stage(noCursor, pagedBackend([]), rows).ctx).ok).toBe(false)
		const noPage = listDoc({ ...spec, params: ["limit", "cursor"] })
		expect(cursorAgreesWithPage.plan(stage(noPage, pagedBackend([]), rows).ctx).ok).toBe(false)
	})

	it("passes cursor and page walks under a text sort that cover the same records", async () => {
		const { ctx, findings, sent } = stage(doc, pagedBackend(rows), rows)
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({ kind: "asserted" })
		expect(queryOf(sent[0]!.options)).toEqual({ limit: 2, page: 1, sort: "name.asc" })
		expect(sent.some((s) => queryOf(s.options)["cursor"] === "4")).toBe(true)
		expect(findings.findings).toEqual([])
	})

	it("walks unsorted where no record holds text to sort by", async () => {
		const { ctx, sent } = stage(doc, pagedBackend(idsOnly(rows)), idsOnly(rows))
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({ kind: "asserted" })
		expect(queryOf(sent[0]!.options)).toEqual({ limit: 2, page: 1 })
	})

	it("walks unsorted where the listing declares no query capability", async () => {
		const plain = listDoc({ ...spec, params: ["limit", "page", "cursor"] })
		const { ctx, sent } = stage(plain, pagedBackend(rows), rows)
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({ kind: "asserted" })
		expect(queryOf(sent[0]!.options)).toEqual({ limit: 2, page: 1 })
	})
})

describe("pagination.cursor-agrees-with-page: cursor walks that disagree", () => {
	it("reports a cursor that re-serves the previous page's tail", async () => {
		/* A record without an identity leads every cursor page. */
		const { ctx, findings } = stage(doc, byCursor(rows, shifted(rows, -1, [{ name: "ghost" }])), rows)
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("cursor pagination re-serves records the previous page already returned")
		expect(findings.findings[0]?.detail).toMatch(
			/^walking by cursor returned 3 record\(s\) more than once \(w02, w03, w04\) /,
		)
		/* Up to the last page that served a record again: all four the cursor walk read. */
		expect(findings.findings[0]?.evidence.map((e) => e.status)).toEqual([200, 200, 200, 200])
	})

	it("reports a cursor walk that loses records the page walk holds", async () => {
		const { ctx, findings } = stage(doc, byCursor(rows, shifted(rows, 1)), rows)
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("cursor pagination and offset pagination disagree")
		expect(findings.findings[0]?.detail).toMatch(
			/^offset walk yielded 5 distinct records, cursor walk yielded 4\. Only in offset: w03\. Only in cursor: —\. /,
		)
		expect(findings.findings[0]?.evidence).toHaveLength(4)
	})

	it("reports a cursor walk holding records the page walk does not", async () => {
		const extra = (query: Record<string, unknown>): Answer => {
			const body = page(rows, query)
			return {
				body: { ...body, items: query["cursor"] === undefined ? [...body.items, { id: "w99" }] : body.items },
				status: 200,
			}
		}
		const { ctx, findings } = stage(doc, byCursor(rows, extra), rows)
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.detail).toMatch(/Only in offset: —\. Only in cursor: w99\. /)
	})
})

describe("pagination.cursor-agrees-with-page: walks cut short", () => {
	it("cannot compare walks cut short with no order to take a prefix of", async () => {
		const many = idsOnly(widgets(20))
		const { ctx, findings } = stage(doc, pagedBackend(many), many)
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({
			kind: "unresolved",
			reason: "a walk was cut short, so the two cannot be compared",
		})
		expect(findings.findings).toEqual([])
	})

	it("compares the prefixes of walks cut short, leaving out ties at the cut", async () => {
		/* Sorted by tag, the cursor walk breaks ties the other way: the twelve records each walk
		 * reaches differ only among those tied with the last. */
		const many = widgets(20)
		const tagged = listDoc({ ...spec, "x-query": { sortable: ["tag"] } })
		const { ctx, sent } = stage(
			tagged,
			byCursor(many.toReversed(), (query) => ({ body: page(many.toReversed(), query), status: 200 })),
			many,
		)
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({ kind: "asserted" })
		expect(queryOf(sent[0]!.options)["sort"]).toBe("tag.asc")
	})

	it("passes a cut-short page walk beside an empty cursor walk", async () => {
		const many = widgets(20)
		const { ctx } = stage(
			doc,
			byCursor(many, () => ({ body: { items: [] }, status: 200 })),
			many,
		)
		expect(await runCheck(cursorAgreesWithPage, ctx)).toEqual({ kind: "asserted" })
	})
})
