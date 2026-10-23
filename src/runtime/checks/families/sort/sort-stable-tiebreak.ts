import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { Record_ } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, MOVING, resolvedCaps } from "../../query/capabilities.ts"
import { compareScalars, tiedSortField } from "../../query/order.ts"
import { settlePair } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"

export const sortStableTiebreak: Check<{ primary: string; tiebreak: string }> = defineCheck<{
	primary: string
	tiebreak: string
}>({
	plan: (ctx) => {
		const tiebreak = resolvedCaps(ctx).sort?.stableTiebreak ?? ctx.query?.stableTiebreak
		if (tiebreak === undefined) return cannot()
		/* Only ties exercise a tiebreak: on distinct keys every implementation looks stable. */
		const primary = tiedSortField(ctx)
		if (primary === null || primary === tiebreak) return cannot("a sortable field with tied values in the cohort")
		return ready({ primary, tiebreak })
	},
	dependsOn: ["pagination.page-walk-covers-set", "sort.order-is-applied"],
	id: "sort.stable-tiebreak",
	needs: "a declared stableTiebreak and a tie on the primary key",
	subjects: subjectsOf.list,
	async run(ctx, { primary, tiebreak }): Promise<Outcome> {
		const order = sortTerm(conv(ctx), { direction: "asc", field: primary })
		/* Two independent reads: a shared one would compare a walk with itself. */
		const read = async () => {
			const result = await readSet(ctx, {}, { fresh: true, order })
			return result.status === "ok" ? result : null
		}
		const firstRead = await read()
		const secondRead = await read()
		if (firstRead === null || secondRead === null)
			return ctx.findings.unresolved(this.id, ctx.entityName, "repeat sort was rejected")
		const settled = await settlePair(
			ctx.identity,
			{ first: firstRead, second: secondRead },
			{ first: read, second: read },
		)
		if (settled === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING)
		if (settled === null) return ctx.findings.unresolved(this.id, ctx.entityName, "repeat sort was rejected")
		const { first, second } = settled
		if (ids(first.items, ctx.identity).join(",") !== ids(second.items, ctx.identity).join(",")) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "the same order is not deterministic across two walks",
				detail: `order=${order} (stableTiebreak=${tiebreak}) returned two different sequences.`,
				evidence: [first.last.exchange, second.last.exchange],
			})
		}
		/* Within a run of equal keys the declared tiebreak decides the order, so its values must
		 * move one way. Which way is the backend's to choose; moving both ways is no tiebreak. */
		const broken: string[] = []
		let run: Record_[] = []
		const flush = (): void => {
			const values = run.map((row) => row[tiebreak]).filter((value) => value !== null && value !== undefined)
			const rising = values.every((value, i) => i === 0 || compareScalars(values[i - 1], value) <= 0)
			const falling = values.every((value, i) => i === 0 || compareScalars(values[i - 1], value) >= 0)
			if (!rising && !falling) broken.push(JSON.stringify(run[0]?.[primary]))
			run = []
		}
		for (const row of first.items) {
			if (run.length > 0 && JSON.stringify(run[0]?.[primary]) !== JSON.stringify(row[primary])) flush()
			run.push(row)
		}
		flush()
		if (broken.length === 0) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "ties are not broken by the declared tiebreak",
			detail:
				`order=${order} returned records tied on ${primary} (${broken.slice(0, 3).join(", ")}) in an ` +
				`order the declared stableTiebreak "${tiebreak}" does not explain. Pagination over such an ` +
				"order can repeat or drop records at a page boundary.",
			evidence: [first.last.exchange],
		})
	},
})
