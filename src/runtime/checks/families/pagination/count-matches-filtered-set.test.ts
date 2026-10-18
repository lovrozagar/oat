import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { countMatchesWalk } from "./count-matches-filtered-set.ts"
import { type ListDoc, listDoc, pagedBackend, queryOf, stage, widgets } from "./__fixtures__/paged.ts"
import type { Record_ } from "../../../world.ts"

const spec: ListDoc = {
	envelope: ["total"],
	params: ["limit", "filter"],
	"x-query": { filterable: ["id"], grammar: "postgrest" },
}
const doc = listDoc(spec)
const rows = widgets(3)

/** A backend that applies `id.eq.<id>` filters, reporting `total` as `count(matched)`. */
function filtering(count: (matched: number) => number | undefined) {
	return pagedBackend(rows, (body, query) => {
		const id = typeof query.filter === "string" ? query.filter.replace("id.eq.", "") : undefined
		const items = id === undefined ? body.items : body.items.filter((row) => row.id === id)
		return { body: { items, total: count(items.length) }, status: 200 }
	})
}

function planOf(d: ListDoc, records: Record_[]) {
	return countMatchesWalk.plan(stage(listDoc(d), pagedBackend([]), records).ctx)
}

describe("count.matches-filtered-set", () => {
	it("plans an equality term on the first record's identity", () => {
		expect(planOf(spec, rows)).toEqual({ ok: true, value: { countTerm: { filter: "id.eq.w01" } } })
	})

	it("does not apply without two records, a filter, or a filterable identity", () => {
		expect(planOf(spec, widgets(1))).toEqual({ ok: false })
		expect(planOf({ envelope: ["total"], params: ["limit"] }, rows)).toEqual({ ok: false })
		expect(planOf({ ...spec, "x-query": { filterable: ["name"], grammar: "postgrest" } }, rows)).toEqual({ ok: false })
	})

	it("needs a grammar that can write equality, and an identity to write it on", () => {
		const needs = { needs: "a filter grammar that can express equality on the identity", ok: false }
		expect(planOf({ ...spec, "x-query": { filterable: ["id"] } }, rows)).toEqual(needs)
		expect(planOf(spec, [{ name: "anonymous" }, ...rows])).toEqual(needs)
	})

	it("writes the term per field where the endpoint filters one parameter per field", () => {
		const perField = planOf({ envelope: ["total"], params: ["limit"], "x-query": { filterable: ["id"] } }, rows)
		expect(perField).toEqual({ ok: true, value: { countTerm: { id: "w01" } } })
	})
})

describe("count.matches-filtered-set: judging the filtered total", () => {
	it("passes a total that counts the filtered records", async () => {
		const { ctx, findings, sent } = stage(
			doc,
			filtering((n) => n),
			rows,
		)
		expect(await runCheck(countMatchesWalk, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => queryOf(s.options))).toEqual([{ filter: "id.eq.w01", limit: 100 }])
		expect(findings.findings).toEqual([])
	})

	it("reports a total that ignores the active filter", async () => {
		const { ctx, findings } = stage(
			doc,
			filtering(() => rows.length),
			rows,
		)
		expect(await runCheck(countMatchesWalk, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings[0]?.summary).toBe("reported count disagrees with the filtered result")
		expect(findings.findings[0]?.detail).toMatch(/^filter selected 1 record\(s\) but count reported 3\. /)
	})

	it("stands down when the listing reports no total", async () => {
		const { ctx } = stage(
			doc,
			filtering(() => undefined),
			rows,
		)
		expect(await runCheck(countMatchesWalk, ctx)).toEqual({
			kind: "stood-down",
			reason: "the listing reports no total",
		})
	})

	it("cannot judge a rejected filtered listing", async () => {
		const { ctx } = stage(doc, () => ({ status: 400 }), rows)
		expect(await runCheck(countMatchesWalk, ctx)).toEqual({
			kind: "unresolved",
			reason: "the filtered listing was rejected",
		})
	})
})
