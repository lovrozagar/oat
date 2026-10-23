import { describe, expect, it } from "vitest"
import type { EffectiveQueryCapabilities } from "../../../../spec/query/effective.ts"
import { runCheck } from "../../core/run.ts"
import { resolvedCaps } from "../../query/capabilities.ts"
import { OPS } from "./__fixtures__/backend.ts"
import { endless, filters, growing, only, REFUSE_FILTERED, reserving, stage, without } from "./__fixtures__/widgets.ts"
import { filterAliasMatchesCanonical as check } from "./filter-alias-matches-canonical.ts"

const COHORT = [
	{ id: "w-1", status: "open" },
	{ id: "w-2", status: "shut" },
	{ id: "w-3", status: "held" },
]
const DOC = { xQuery: { aliases: { ne: "neq" }, filterable: [{ field: "status", ops: ["eq", "neq"] }] } }
/** FILTER_ALIAS_MISMAPPED: the ne alias is mapped to eq instead of neq. */
const MISMAPPED = { ops: { ne: OPS["eq"] } }

describe("filter.alias-matches-canonical", () => {
	it("asserts when the alias selects the same set as its canonical operator", async () => {
		const { ctx, findings, sent } = stage({ doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
		expect(filters(sent)).toEqual(["status.ne.open", "status.neq.open"])
		expect(findings.findings).toEqual([])
	})

	it("reports an alias mapped to the wrong operator", async () => {
		const { ctx, findings } = stage({ behavior: MISMAPPED, doc: DOC, records: COHORT })
		expect(await runCheck(check, ctx)).toMatchObject({ kind: "finding" })
		const finding = only(findings)
		expect(finding.summary).toBe("alias ne does not select the same set as neq")
		expect(finding.detail).toBe("status.ne and status.neq disagreed on membership.")
	})

	it("is unresolved when a listing is refused, incomplete, or moving", async () => {
		const refused = stage({ behavior: REFUSE_FILTERED, doc: DOC, records: COHORT })
		expect(await runCheck(check, refused.ctx)).toMatchObject({ reason: "alias ne or neq was rejected" })
		const partial = stage({ ...endless(DOC), records: COHORT })
		expect(await runCheck(check, partial.ctx)).toMatchObject({
			reason: "the collection is larger than the walk covers",
		})
		const store = growing(COHORT, 2, { id: "w-4", status: "shut" })
		const moving = stage({ behavior: MISMAPPED, doc: DOC, records: COHORT, store })
		expect(await runCheck(check, moving.ctx)).toMatchObject({ reason: expect.stringContaining("gained or lost rows") })
	})

	it("skips an alias it cannot probe and asserts without a request", async () => {
		const caps = resolvedCaps(stage({ doc: DOC, records: COHORT }).ctx)
		const unprobeable: Array<{ aliases: Record<string, unknown>; options?: Partial<Parameters<typeof stage>[0]> }> = [
			{ aliases: { zz: "eq" } },
			{ aliases: { ne: undefined } },
			{ aliases: { ne: "gt" } },
			{ aliases: { ne: "neq" }, options: { conventions: without("ne") } },
			{ aliases: { ne: "neq" }, options: { records: [{ id: "w-1" }] } },
			{ aliases: { ne: "neq" }, options: { conventions: reserving("o") } },
		]
		for (const { aliases, options } of unprobeable) {
			const capabilities = { ...caps, aliases: aliases as EffectiveQueryCapabilities["aliases"] }
			const { ctx, sent } = stage({ doc: DOC, fields: { capabilities }, records: COHORT, ...options })
			expect(await runCheck(check, ctx)).toEqual({ kind: "asserted" })
			expect(sent).toEqual([])
		}
	})

	it("stands down without a declared alias or a filter", () => {
		expect(check.plan(stage({ doc: { xQuery: { filterable: ["status"] } }, records: COHORT }).ctx).ok).toBe(false)
		expect(check.plan(stage({ doc: { ...DOC, filterParam: false }, records: COHORT }).ctx).ok).toBe(false)
	})
})
