import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import type { SortValue } from "../../../../spec/render/sort.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { CheckContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageable, pageSize } from "../../query/capabilities.ts"
import { tiedSortField } from "../../query/order.ts"
import { duplicates } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"
import { MAX_WALK_PAGES, walkPages } from "./walk.ts"

/** Two identical walks that disagree: on order alone, or on which records they hold. */
function reportUnstableWalks(
	ctx: CheckContext,
	check: string,
	walks: { walked: string[]; second: string[]; orderParam: SortValue | undefined },
	evidence: Exchange,
): Outcome {
	const { orderParam, second, walked } = walks
	const sameMembers = [...second].sort().join(",") === [...walked].sort().join(",")
	return ctx.findings.backend(check, ctx.entityName, {
		summary: sameMembers
			? "identical page walks return records in different orders"
			: "identical page walks return different records",
		detail:
			`walking the collection twice with the same parameters` +
			(orderParam === undefined ? "" : ` (order=${orderParam})`) +
			` produced ${sameMembers ? "the same records in a different order" : "different sets"}. ` +
			"Pagination requires a total order; without a tiebreak the page boundary moves between " +
			"requests and callers silently miss or repeat rows.",
		evidence: [evidence],
	})
}

export const pageWalkCoversSet: Check = defineCheck({
	/* Walked by whatever the endpoint pages by — a cursor alone is enough. */
	plan: (ctx) => when((pageable(ctx) || conv(ctx).cursor !== undefined) && ctx.records.length > 2),
	dependsOn: [
		"list.read-after-write",
		"pagination.limit-bounds-page-size",
		"pagination.has-more-is-accurate",
		/* A page walk is only sound over a total order. Where the requested order is discarded,
		 * the pages are windows onto an arbitrary sequence, and any drift they show is the
		 * missing sort rather than a pagination defect. */
		"sort.order-is-applied",
	],
	id: "pagination.page-walk-covers-set",
	needs: "a way to page forward — a page number, a row offset or a cursor — and at least three records",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const limit = pageSize(ctx)
		/* Walk under a low-cardinality sort. Distinct keys admit exactly one valid order, so an
		 * unstable sort is indistinguishable from a correct one until values tie. */
		const order = tiedSortField(ctx)
		const orderParam = order === null ? undefined : sortTerm(conv(ctx), { direction: "asc", field: order })
		/* The whole set, read at the largest page: what a walk at two per page must reproduce. */
		void limit
		const whole = await readSet(ctx, {}, { order: orderParam })
		const single = whole.last
		const expected = ids(whole.items, ctx.identity)
		/* Two per page, so every record sits near a page boundary — unless the collection is too
		 * large to walk that way within the page cap, when pages grow just enough to reach its end.
		 * A walk cut short proves nothing about what it never reached. */
		const walkSize = Math.min(limit, Math.max(2, Math.ceil(expected.length / (MAX_WALK_PAGES - 1))))
		const walk = await walkPages(ctx, walkSize, orderParam)
		const walked = walk.ids

		const repeated = duplicates(walked)
		if (repeated.length > 0) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "paging returns the same record on more than one page",
				detail:
					`walking at limit=${walkSize} returned ${repeated.length} duplicated id(s): ${repeated.slice(0, 3).join(", ")}. ` +
					"This is the signature of a sort without a total order — the page boundary is not stable.",
				evidence: [single.exchange],
			})
		}
		/* A capped walk saw only a prefix of the collection, so "missing" would just mean "beyond
		 * the cap". Duplicates above are still meaningful; absence is not. */
		const missing = walk.truncated || !whole.complete ? [] : expected.filter((id) => !walked.includes(id))
		if (missing.length > 0) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "paging skips records that a single large page returns",
				detail:
					`a single page at limit=${limit} returned ${expected.length} records, but walking at ` +
					`limit=${walkSize} yielded ${walked.length} and missed ${missing.length}: ${missing.slice(0, 3).join(", ")}`,
				evidence: [single.exchange],
			})
		}

		/* Instability is probabilistic: one walk can come out intact by luck. Two identical walks
		 * must agree, so comparing them tests the ordering guarantee directly rather than waiting
		 * for a dropped row to happen to appear. */
		const second = (await walkPages(ctx, walkSize, orderParam)).ids
		if (second.join(",") === walked.join(",")) return ASSERTED
		return reportUnstableWalks(ctx, this.id, { orderParam, second, walked }, single.exchange)
	},
})
