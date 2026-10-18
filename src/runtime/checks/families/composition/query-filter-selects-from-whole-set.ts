import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf, type Record_ } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { andThen, ready, when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"
import type { SetRead } from "../../sets/read.ts"
import { ids } from "../../sets/list.ts"
import { type Subset, subsetPlan } from "./plans.ts"

/* One row per page, deliberately: the bug only shows once a window excludes matching rows, and a
 * one-row window that does not match comes back empty and ends the walk, so every later match is
 * lost. Any larger page leaves detection to how matches happen to fall. */
const ROWS_PER_PAGE = 1

/** The collection walked unfiltered and walked with the filter pushed to the server. */
async function walkBothWays(
	ctx: CheckContext,
	term: Record<string, string>,
	matches: (row: Record_) => boolean,
): Promise<{ everything: SetRead | null; serverSide: SetRead | null }> {
	const tiebreak = ctx.query?.sortable.includes(ctx.identity) === true ? ctx.identity : undefined
	const walkOrder = tiebreak === undefined ? undefined : sortTerm(conv(ctx), tiebreak, "asc")
	const everything = await collectSet(ctx, ROWS_PER_PAGE, {}, { order: walkOrder })
	const serverSide = await collectSet(ctx, ROWS_PER_PAGE, term, { order: walkOrder })
	/* Rows that do not match mean the filter was not applied to this walk. A backend that drops
	 * the filter once a sort is present does exactly that to the sorted walk, and every row it
	 * skipped would hide among the extras — so walk again without the sort. */
	if (walkOrder !== undefined && serverSide !== null && !serverSide.items.every(matches)) {
		return {
			everything: await collectSet(ctx, ROWS_PER_PAGE, {}),
			serverSide: await collectSet(ctx, ROWS_PER_PAGE, term),
		}
	}
	return { everything, serverSide }
}

/**
 * A filter must select from the whole collection, not from whichever page happened to be built.
 *
 * The failure this catches is one of *ordering of operations*: resolve the offset or cursor first,
 * then apply the predicate to whatever that window contained. Page one usually looks correct,
 * which is how it survives review — the damage is further in, where pages come back short and
 * matching records are never returned at all.
 *
 * The oracle needs no ground truth because oat can compute the answer two ways. Walk the
 * collection unfiltered and apply the predicate client-side; walk it again with the predicate
 * pushed to the server. A backend that filters before paging returns the same set both times. One
 * that pages first returns a subset, and the difference is exactly the records it skipped.
 */
export const filterAndPagingCompose = defineCheck<Subset & { value: unknown }>({
	plan: (ctx) =>
		andThen(when(filterable(ctx) && ctx.records.length > 2), () =>
			andThen(subsetPlan(ctx), (subset) => ready({ ...subset, value: subset.target[subset.field] })),
		),
	/*
	 * A foundation, not a composition: every check that reads a filtered set relies on the filter
	 * applying to the whole collection, so they depend on this and not the other way round. A
	 * filter dropped once a sort is present is walked around without the sort; one ignored outright
	 * leaves this unresolved, and the check that owns that defect reports it.
	 */
	dependsOn: [
		"list.read-after-write",
		/* Both sides are walks, so a broken walk changes both for reasons that are not about
		 * where the predicate is applied. */
		"pagination.page-walk-covers-set",
	],
	id: "query.filter-selects-from-whole-set",
	needs: "a filterable field and more than two records",
	subjects: subjectsOf.list,
	async run(ctx, { field, term, value }): Promise<Outcome> {
		const matches = (row: Record_): boolean => JSON.stringify(row[field]) === JSON.stringify(value)
		const { everything, serverSide } = await walkBothWays(ctx, term, matches)
		if (everything === null || serverSide === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection could not be walked in both filtered and unfiltered form",
			)
		}
		if (!everything.complete || !serverSide.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the two sets are not comparable",
			)
		}

		if (!serverSide.items.every(matches)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the filter was not applied at all, so where it is applied cannot be judged",
			)
		}

		/* The predicate applied by oat, over everything the API served. */
		const clientSide = new Set(everything.items.filter(matches).flatMap((row) => idOf(row, ctx.identity) ?? []))
		const returned = new Set(ids(serverSide.items, ctx.identity))
		const skipped = [...clientSide].filter((id) => !returned.has(id))
		if (skipped.length === 0) return ASSERTED

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "paging a filtered query skips records that match the filter",
			detail:
				`walking the collection at ${ROWS_PER_PAGE} per page and filtering client-side on ` +
				`"${field}" = ${JSON.stringify(value)} finds ${clientSide.size} record(s); asking the ` +
				`backend for the same filter returns ${returned.size}. Never returned: ` +
				`${skipped.slice(0, 3).join(", ")}. The page window is being computed before the ` +
				"predicate is applied, so matching records fall outside it and are lost — page one " +
				"looks correct and later pages silently omit data.",
			evidence: [everything.last.exchange, serverSide.last.exchange],
		})
	},
})
