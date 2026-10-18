import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { NOTES, PARAMS, queryDoc, REJECT, stage } from "../composition/__fixtures__/query-api.ts"
import { answering, ignoring } from "./__fixtures__/responders.ts"
import { searchNarrowsResult } from "./search-q-narrows-result.ts"

const NO_MATCH = "zzqqxx-oat-no-match-token"

/* One record, whatever is asked. */
const single: Responder = () => ({ body: [NOTES[0]], status: 200 })

describe("search.q-narrows-result judges", () => {
	it("passes a search that returns nothing for a token no record holds", async () => {
		const staged = stage(searchNarrowsResult)
		expect(await staged.run()).toEqual({ kind: "asserted" })
		expect(staged.sent.map((sent) => sent.options.query)).toEqual([{ limit: 50 }, { limit: 50, q: NO_MATCH }])
	})

	it("fails a search parameter that is accepted and ignored", async () => {
		const staged = stage(searchNarrowsResult, { respond: ignoring("q") })
		expect(await staged.run()).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = staged.findings.findings
		expect(finding?.summary).toBe("free-text search returns records that cannot match")
		expect(finding?.detail).toContain("returned 6 of 6 records")
		expect(finding?.evidence).toHaveLength(2)
	})
})

describe("search.q-narrows-result gives up", () => {
	it("is unresolved with fewer than two records listed", async () => {
		const staged = stage(searchNarrowsResult, { respond: single })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "fewer than two records to narrow" })
		expect(staged.sent).toHaveLength(1)
	})

	it("is unresolved when the search itself is refused", async () => {
		const staged = stage(searchNarrowsResult, { respond: answering("q", NO_MATCH, REJECT) })
		expect(await staged.run()).toEqual({ kind: "unresolved", reason: "the search was rejected" })
	})
})

describe("search.q-narrows-result plans", () => {
	it("plans on the first searchable field", () => {
		expect(stage(searchNarrowsResult).plan()).toEqual({ ok: true, value: { field: "title" } })
	})

	it("stands down without a search parameter, a searchable field, or more than two records", async () => {
		const noParam = stage(searchNarrowsResult, {
			doc: queryDoc(
				{},
				PARAMS.filter((name) => name !== "q"),
			),
		})
		expect(await noParam.run()).toEqual({
			kind: "stood-down",
			reason: "a free-text `q` parameter and declared searchable fields",
		})
		expect(noParam.sent).toEqual([])
		expect(stage(searchNarrowsResult, { doc: queryDoc({ searchable: [] }) }).plan().ok).toBe(false)
		expect(stage(searchNarrowsResult, { fields: { query: null } }).plan().ok).toBe(false)
		expect(stage(searchNarrowsResult, { rows: NOTES.slice(0, 2) }).plan().ok).toBe(false)
	})
})
