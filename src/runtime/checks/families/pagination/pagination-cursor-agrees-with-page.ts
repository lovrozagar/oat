import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions.ts"
import type { SortValue } from "../../../../spec/sort-render.ts"
import type { Exchange } from "../../../client.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf, type Record_ } from "../../../world.ts"
import type { CheckContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { NO_KEY, subjectsOf } from "../../planning/subjects.ts"
import { conv, pageable } from "../../query/capabilities.ts"
import { duplicates } from "../../sets/compare.ts"
import { extractItems, ids, type Walk } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"
import { MAX_WALK_PAGES, walkPages } from "./walk.ts"

async function walkCursor(
	ctx: CheckContext,
	perPage: number,
	order?: SortValue,
	maxPages = MAX_WALK_PAGES,
): Promise<Walk> {
	const read = await readSet(
		ctx,
		{},
		{ byCursor: true, fresh: true, keepRepeats: true, maxPages, order, size: perPage },
	)
	return {
		exchanges: read.pages.map((page) => page.exchange),
		ids: ids(read.items, ctx.identity),
		items: read.items,
		truncated: !read.complete,
	}
}

/**
 * A sortable text field the cohort holds non-empty values for. Cursor pagination is almost always
 * used with one, and a boundary resolved under a different collation than the listing can only
 * diverge when the ordering key is text.
 */
function textSortField(ctx: CheckContext): string | undefined {
	return (
		ctx.query?.sortable.find((f) => {
			if (f === ctx.identity) return false
			return ctx.records.some((r) => typeof r[f] === "string" && r[f] !== "")
		}) ?? undefined
	)
}

/** The cursor pages up to the one that served a record again. */
function repeatEvidence(ctx: CheckContext, cursorWalk: Walk, repeated: string[]): Exchange[] {
	return cursorWalk.exchanges.slice(
		0,
		Math.max(
			2,
			1 +
				cursorWalk.exchanges.findLastIndex((exchange) =>
					extractItems(exchange.responseBody, ctx.collectionKey).some((item) =>
						repeated.includes(idOf(item, ctx.identity) ?? NO_KEY),
					),
				),
		),
	)
}

/**
 * Two walks capped at the same number of equal pages cover the same prefix of one order, so their
 * prefixes compare — except across a tie at the cut, where either of the tied records may
 * legitimately fall inside. Those are left out. With no explicit order there is no prefix to speak
 * of, and a capped walk proves nothing: `null`.
 */
function comparablePrefixes(
	pageWalk: Walk,
	cursorWalk: Walk,
	sortField: string | undefined,
): { pageItems: Record_[]; cursorItems: Record_[] } | null {
	if (!pageWalk.truncated && !cursorWalk.truncated) return { cursorItems: cursorWalk.items, pageItems: pageWalk.items }
	if (sortField === undefined) return null
	const length = Math.min(pageWalk.items.length, cursorWalk.items.length)
	const atCut = JSON.stringify(pageWalk.items[length - 1]?.[sortField])
	const clear = (items: Record_[]): Record_[] =>
		items.slice(0, length).filter((item) => JSON.stringify(item[sortField]) !== atCut)
	return { cursorItems: clear(cursorWalk.items), pageItems: clear(pageWalk.items) }
}

export const cursorAgreesWithPage = /* @__PURE__ */ defineCheck({
	plan: (ctx) => when(conv(ctx).cursor !== undefined && pageable(ctx) && ctx.records.length > 2),
	dependsOn: [
		"pagination.page-walk-covers-set",
		/* Sorting by a field whose value never persisted is degenerate, so a pagination
		 * disagreement there describes a consequence rather than a pagination defect. */
		"create.persists-submitted-fields",
		/* Both walks are taken at a requested page size. If the backend serves a different size
		 * than asked for, the two walks step differently and disagree for that reason alone. */
		"pagination.limit-respects-documented-max",
	],
	id: "pagination.cursor-agrees-with-page",
	needs: "both `cursor` and `page` parameters",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		/* Walk under an explicit text sort. */
		const sortField = textSortField(ctx)
		const order = sortField === undefined ? undefined : sortTerm(conv(ctx), sortField, "asc")

		const pageWalk = await walkPages(ctx, 2, order)
		const cursorWalk = await walkCursor(ctx, 2, order)
		const byPage = pageWalk.ids
		const byCursor = cursorWalk.ids

		/* Repeats are their own defect: a cursor that resolves to the wrong boundary re-serves the
		 * previous page's tail, which set comparison alone would hide. */
		const repeated = duplicates(byCursor).filter((id) => !duplicates(byPage).includes(id))
		if (repeated.length > 0) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"cursor pagination re-serves records the previous page already returned",
				`walking by cursor returned ${repeated.length} record(s) more than once ` +
					`(${repeated.slice(0, 3).join(", ")}) while the offset walk returned each exactly once. ` +
					"The cursor is resolving to the wrong boundary.",
				repeatEvidence(ctx, cursorWalk, repeated),
			)
		}

		const prefixes = comparablePrefixes(pageWalk, cursorWalk, sortField)
		if (prefixes === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a walk was cut short, so the two cannot be compared")
		}

		const pageSet = [...new Set(ids(prefixes.pageItems, ctx.identity))].sort()
		const cursorSet = [...new Set(ids(prefixes.cursorItems, ctx.identity))].sort()
		if (pageSet.join(",") === cursorSet.join(",")) return ASSERTED

		const onlyPage = pageSet.filter((id) => !cursorSet.includes(id))
		const onlyCursor = cursorSet.filter((id) => !pageSet.includes(id))
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"cursor pagination and offset pagination disagree",
			`offset walk yielded ${pageSet.length} distinct records, cursor walk yielded ${cursorSet.length}. ` +
				`Only in offset: ${onlyPage.slice(0, 3).join(", ") || "—"}. ` +
				`Only in cursor: ${onlyCursor.slice(0, 3).join(", ") || "—"}. ` +
				"Both traverse the same collection, so one of them is losing or repeating rows.",
			[...pageWalk.exchanges.slice(0, 2), ...cursorWalk.exchanges.slice(0, 2)],
		)
	},
})
