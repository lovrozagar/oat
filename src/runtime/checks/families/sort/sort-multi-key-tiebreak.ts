import { defineCheck } from "../../core/define.ts"
import { sortKeys } from "../../../../spec/conventions.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { Record_ } from "../../../world.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, resolvedCaps } from "../../query/capabilities.ts"
import { sortedUnder } from "../../query/order.ts"
import { cohortFact, collectSet } from "../../sets/compare.ts"

function pickMultiKeyPair(ctx: CheckContext): { primary: string; secondary: string; tied: Record_[] } | null {
	return cohortFact(ctx, "multi-key", () => computePickMultiKeyPair(ctx))
}

function computePickMultiKeyPair(ctx: CheckContext): { primary: string; secondary: string; tied: Record_[] } | null {
	const fields = ctx.query?.sortable ?? []
	for (const primary of fields) {
		for (const secondary of fields) {
			if (secondary === primary || secondary === ctx.identity) continue
			const groups = new Map<string, Record_[]>()
			/* A field a row does not carry is no value to tie on, and no value to order by. */
			for (const row of ctx.records.filter(
				(record) => record[primary] !== undefined && record[secondary] !== undefined,
			)) {
				const key = JSON.stringify(row[primary])
				const group = groups.get(key) ?? []
				group.push(row)
				groups.set(key, group)
			}
			const tied = [...groups.values()].find(
				(group) => group.length >= 2 && new Set(group.map((row) => JSON.stringify(row[secondary]))).size > 1,
			)
			if (tied !== undefined) return { primary, secondary, tied }
		}
	}
	return null
}

export const sortMultiKeyTiebreak = defineCheck<{
	primary: string
	secondary: string
	tied: Record_[]
}>({
	plan: (ctx) => {
		const max = resolvedCaps(ctx).sort?.maxKeys
		if (conv(ctx).order === undefined || (max !== undefined && max < 2)) return cannot()
		if (
			sortKeys(conv(ctx), [
				["a", "asc"],
				["b", "desc"],
			]) === null
		)
			return cannot("a sort grammar that joins keys")
		const pair = pickMultiKeyPair(ctx)
		return pair === null ? cannot() : ready(pair)
	},
	dependsOn: ["sort.order-is-applied", "sort.reverse-symmetry"],
	id: "sort.multi-key-tiebreak",
	needs: "two sortable fields and rows that tie on the first and differ on the second",
	subjects: subjectsOf.list,
	async run(ctx, { primary, secondary, tied }): Promise<Outcome> {
		const conventions = conv(ctx)
		/* The second key descending: whatever tiebreak a server applies on its own runs ascending,
		 * and asking for the same field ascending would let that accident pass for a second key. */
		const order = sortKeys(conventions, [
			[primary, "asc"],
			[secondary, "desc"],
		])
		if (order === null) return ctx.findings.unresolved(this.id, ctx.entityName, "the grammar sorts by one key only")
		const result = await collectSet(ctx, pageSize(ctx), {}, { order })
		if (result === null) return ctx.findings.unresolved(this.id, ctx.entityName, "multi-key order was rejected")
		const slice = result.items.filter(
			(item) => item[secondary] !== undefined && JSON.stringify(item[primary]) === JSON.stringify(tied[0]?.[primary]),
		)
		/* The listing must show the tie it is judged on: rows without the keys say nothing. */
		if (slice.length < 2) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `the listing does not show rows tied on ${primary}`)
		}
		const seconds = slice.map((item) => item[secondary]).toReversed()
		if (sortedUnder(ctx, secondary, seconds) !== null) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"the second sort key is not applied on ties",
			`order=${order} left ties on "${primary}" unordered by "${secondary}".`,
			[result.last.exchange],
		)
	},
})
