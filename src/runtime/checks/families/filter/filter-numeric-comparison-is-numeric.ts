import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import type { Listed } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { storedFieldsUnknown } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable } from "../../query/capabilities.ts"
import { ids } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"
import { knownHits } from "./fields.ts"

/**
 * Order matters. Cascade suppression consults findings already reported for this entity, so a
 * check must run after everything it depends on — primitives first, then the properties built
 * on top of them. Otherwise a broken primitive is reported once as itself and again as every
 * downstream consequence.
 */
/**
 * An operation declaring `x-effects` must produce the stated change.
 *
 * `count` is an exact cardinality delta (default 1). `min` is at-least. After a `create` on A,
 * later items in the same array fill a child list under A with the new id — from the write
 * response (`table_id` or the entity identity) or from A's list delta.
 *
 * `x-invalidate` says a read route changes; `x-effects` says *how*. That difference is what
 * separates "something differed" — which is satisfied by a stray timestamp and missed by a
 * cache-stale read — from an assertion on cardinality and membership.
 */
/**
 * A numeric field must compare numerically, not lexically.
 *
 * Query values arrive from a URL as text, and a backend that forgets to coerce them compares
 * "10" < "9" — so `amount.gt.9` silently omits 10, 20 and 100. The result is a plausible-looking
 * subset rather than an error, which is why it survives in production.
 */
export const numericComparisonIsNumeric: Check<{
	field: string
	threshold: number
	expected: string[]
	gtTerm: Record<string, string>
}> = defineCheck<{
	field: string
	threshold: number
	expected: string[]
	gtTerm: Record<string, string>
}>({
	plan: (ctx) => {
		const unverified = storedFieldsUnknown(ctx)
		if (unverified !== undefined) return unverified
		const field = filterable(ctx) && ctx.records.length > 2 ? numericFilterField(ctx) : null
		if (field === null) return cannot()
		/* `numericFilterField` picks a field at least three cohort records hold a number in. */
		const values = ctx.records.map((r) => r[field]).filter((v): v is number => typeof v === "number")
		/* A threshold that partitions the cohort, chosen so the lexical and numeric answers
		 * differ — comparing as text has to produce a visibly wrong set for this to prove
		 * anything. */
		const sorted = [...new Set(values)].sort((a, b) => a - b)
		const threshold = sorted[Math.floor(sorted.length / 2)] as number
		const expected = ctx.records
			.filter((r) => typeof r[field] === "number" && (r[field] as number) > threshold)
			.flatMap((r) => idOf(r, ctx.identity) ?? [])
			.sort()
		if (expected.length === 0) return cannot(`a cohort value of "${field}" above the median`)
		const gtTerm = filterTerm(conv(ctx), { field, op: "gt", value: threshold })
		if (gtTerm === null) return cannot("a filter grammar with a gt operator")
		return ready({ expected, field, gtTerm, threshold })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"pagination.page-walk-covers-set",
		"list.read-after-write",
		"filter.unknown-field-rejected",
	],
	id: "filter.numeric-comparison-is-numeric",
	lists: true,
	needs: "a `filter` parameter and a numeric field",
	subjects: subjectsOf.list,
	async run(ctx, { expected, field, gtTerm, threshold }): Promise<Outcome> {
		/* The whole filtered set: a record above the threshold on the second page is not missing. */
		const read = await readSet(ctx, gtTerm)
		if (read.status !== "ok") {
			/* An unresolved read always says which page was refused, and with what. */
			return ctx.findings.unresolved(this.id, ctx.entityName, read.reason as string)
		}
		if (!read.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the filtered set is larger than a read covers")
		}
		const result = read.last
		const got = ids(read.items, ctx.identity)
		const gotKnown = [...knownHits(read.items, ctx)].sort()
		if (gotKnown.join(",") === expected.join(",")) return ASSERTED

		const missing = expected.filter((id) => !gotKnown.includes(id))
		const extra = gotKnown.filter((id) => !expected.includes(id))
		const lexical = expected.filter((id) => {
			const record = ctx.records.find((r) => idOf(r, ctx.identity) === id)
			return record !== undefined && String(record[field]) < String(threshold)
		})
		const comparedAsText = missing.length > 0 && missing.every((id) => lexical.includes(id))

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: comparedAsText
				? `"${field}" is compared as text rather than as a number`
				: `"${field}" comparison does not agree with numeric ordering`,
			detail:
				`filter=${field}.gt.${threshold} returned ${got.length} record(s); ${expected.length} known ` +
				`records hold a greater numeric value. Missing: ${missing.slice(0, 4).join(", ") || "none"}. ` +
				`Unexpected: ${extra.slice(0, 4).join(", ") || "none"}. ` +
				(comparedAsText
					? "Every missing record is one whose value sorts below the threshold as a string, " +
						"so the comparison is lexical: the query value was never coerced from text."
					: "The comparison does not agree with numeric ordering."),
			evidence: [result.exchange],
		})
	},
})

function numericFilterField(ctx: Listed): string | null {
	for (const field of ctx.query?.filterable ?? []) {
		if (field === ctx.identity) continue
		const values = ctx.records.map((r) => r[field])
		const numbers = values.filter((v) => typeof v === "number")
		if (numbers.length < 3) continue
		/* Only useful when text and numeric ordering actually disagree across the cohort. */
		const asNumbers = [...new Set(numbers as number[])].sort((a, b) => a - b)
		const asText = [...new Set(numbers as number[])].sort((a, b) => String(a).localeCompare(String(b)))
		if (asNumbers.join(",") !== asText.join(",")) return field
	}
	return null
}
