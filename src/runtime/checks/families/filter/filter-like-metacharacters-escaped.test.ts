import { describe, expect, it } from "vitest"
import { runCheck } from "../../core/run.ts"
import { resolvedCaps } from "../../query/capabilities.ts"
import { endless, filters, grammar, only, stage, without } from "./__fixtures__/widgets.ts"
import { likeEscaping as check } from "./filter-like-metacharacters-escaped.ts"

const COHORT = [
	{ id: "w-1", name: "alpha" },
	{ id: "w-2", name: "beta" },
]
const DOC = { xQuery: { filterable: ["status", "name"], searchable: ["name"] } }
/** LIKE_UNESCAPED: `%` interpolated into the pattern as a wildcard. */
const UNESCAPED = { ops: { like: (value: unknown, arg: string) => typeof value === "string" && arg === "%" } }

describe("filter.like-metacharacters-escaped: run", () => {
	it("asserts when a literal % matches fewer records than the whole listing", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["-", "name.like.%"])
		expect(findings.findings).toEqual([])
	})

	it("reports a % that matches every record", async () => {
		const { ctx, findings } = stage({ behavior: UNESCAPED, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		expect(only(findings).detail).toContain("filter=name.like.%25 matched all 2 records.")
	})

	it("is unresolved when the probe is refused, a read is partial, or the listing is empty", async () => {
		const refused = stage({
			behavior: { status: (query) => (query.filter === undefined ? undefined : 400) },
			doc: DOC,
			records: COHORT,
		})
		expect(await runCheck(check, refused.ctx)).toMatchObject({
			reason: "the like probe was rejected with 400, so escaping was never exercised",
		})
		const baselineRefused = stage({
			behavior: { status: (query) => (query.filter === undefined ? 400 : undefined) },
			doc: DOC,
			records: COHORT,
		})
		expect(await runCheck(check, baselineRefused.ctx)).toMatchObject({
			reason: "the sets are larger than a read covers",
		})
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({ reason: "the sets are larger than a read covers" })
		const empty = stage({ doc: DOC, records: COHORT, store: [] })
		expect(await runCheck(check, empty.ctx)).toMatchObject({
			reason: "the unfiltered listing returned nothing, leaving no baseline to compare the probe against",
		})
	})
})

describe("filter.like-metacharacters-escaped: plan", () => {
	it("stands down without a filter, two records, or a field both filterable and searchable", () => {
		expect(check.plan(stage({ doc: { ...DOC, filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: DOC, records: COHORT.slice(0, 1) }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["name"] } }, records: COHORT }).ctx)).toEqual({
			needs: "a field that is both filterable and searchable",
			ok: false,
		})
		const caps = resolvedCaps(stage({ doc: DOC, records: COHORT }).ctx)
		expect(check.plan(stage({ doc: DOC, fields: { capabilities: caps, query: null }, records: COHORT }).ctx).ok).toBe(
			false,
		)
	})

	it("stands down where % is the declared wildcard, or like cannot be written", () => {
		const percent = grammar((spec) => ({ ...spec, likeWildcard: "%" }))
		expect(check.plan(stage({ conventions: percent, doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a like operator that reads % literally",
			ok: false,
		})
		expect(check.plan(stage({ conventions: without("like"), doc: DOC, records: COHORT }).ctx)).toEqual({
			needs: "a filter grammar with a like operator",
			ok: false,
		})
	})
})
