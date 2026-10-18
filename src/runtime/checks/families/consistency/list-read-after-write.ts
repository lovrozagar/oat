import { defineCheck } from "../../core/define.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { itemParamFor, NO_IDENTITY, subjectsOf } from "../../planning/subjects.ts"
import { pageSize } from "../../query/capabilities.ts"
import { collectSet } from "../../sets/compare.ts"
import { type ListResult } from "../../sets/list.ts"

/* -------------------------------------------------------------------- checks */

export const readAfterWrite = defineCheck<{ id: string }>({
	plan: (ctx) => {
		const id = idOf(ctx.records[0], ctx.identity)
		return ctx.createOp === undefined || id === undefined ? cannot(NO_IDENTITY) : ready({ id })
	},
	mutates: true,
	/* A record stored under an id the client was never told cannot be found by it: that is the cause. */
	dependsOn: ["create.keeps-submitted-identity"],
	id: "list.read-after-write",
	needs: "a create operation and at least one seeded record",
	subjects: subjectsOf.createAndList,
	async run(ctx, { id }): Promise<Outcome> {
		const walkSize = pageSize(ctx)
		let located = await locate(ctx, id, walkSize)
		/* A record that appears on a repeat walk was never lost — it was unreachable for one
		 * query. That is an ordering defect, which the pagination checks diagnose precisely;
		 * reporting it here as a lost write would name the wrong cause. This check is about
		 * records the list *never* shows. */
		for (let attempt = 0; attempt < 2 && located.status === "missing"; attempt++) {
			located = await locate(ctx, id, walkSize, { fresh: true })
		}
		if (located.status === "missing" && (await foundAtOtherPageSize(ctx, id, walkSize))) return ASSERTED
		if (located.status === "found") return ASSERTED
		if (located.status === "unresolved") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`${located.reason}, so whether the write is visible cannot be decided`,
			)
		}
		return reportLostWrite(ctx, this.id, id, located.last)
	},
})

/** Where one walk of the list found the record. */
type Located = { status: "found" | "missing"; last: ListResult } | { status: "unresolved"; reason: string }

/*
 * Walk by short page, never by `hasMore` alone: a backend whose more-pages signal is
 * wrong would make a record on page two look like a lost write.
 *
 * Deliberately unsorted. STALE_LIST only freezes the default listing — adding `order`
 * takes a live path and the defect vanishes. An unstable default order can hide a
 * record for one walk; a repeat that finds it was never a lost write.
 */
async function locate(
	ctx: CheckContext,
	id: string,
	walkSize: number,
	/* A repeat walk reads the list again; an earlier walk's memoized pages would hide it. */
	{ fresh = false }: { fresh?: boolean } = {},
): Promise<Located> {
	const gathered = await collectSet(ctx, walkSize, {}, { fresh })
	if (gathered === null) return { reason: "the list was rejected", status: "unresolved" }
	if (gathered.items.some((item) => idOf(item, ctx.identity) === id)) {
		return { last: gathered.last, status: "found" }
	}
	/* Absent from a walk that stopped early is not absent from the list. */
	if (!gathered.complete) {
		return { reason: gathered.reason, status: "unresolved" }
	}
	return { last: gathered.last, status: "missing" }
}

/*
 * Missing from every walk, but a walk crosses page boundaries, and a backend that pages
 * wrongly loses records exactly there. A walk at another page size puts the boundaries
 * elsewhere: a record it finds was lost to paging, which the pagination checks own, not to
 * the write.
 */
async function foundAtOtherPageSize(ctx: CheckContext, id: string, walkSize: number): Promise<boolean> {
	/* The walk already uses the largest documented size (`pageSize`), so one smaller moves the
	 * boundaries; a walk of single records has no smaller size to move them to. */
	if (walkSize <= 1) return false
	const moved = await collectSet(ctx, walkSize - 1)
	return moved?.items.some((item) => idOf(item, ctx.identity) === id) === true
}

/** The record is absent from every walk; the item route, where there is one, says whether it exists. */
async function reportLostWrite(ctx: CheckContext, check: string, id: string, last: ListResult): Promise<Outcome> {
	const evidence: Exchange[] = [last.exchange]
	let detail = `created ${ctx.entityName} ${id} is absent from the list projection`
	if (ctx.readOp !== undefined) {
		const item = await ctx.client.get(fillPath(ctx.readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
			headers: ctx.auth(),
		})
		evidence.push(item)
		if (item.status < 300) {
			detail =
				`created ${ctx.entityName} ${id} is served by the item route (${item.status}) but ` +
				"does not appear in the list route — the two projections disagree"
		}
	}
	return ctx.findings.backend(check, ctx.entityName, {
		summary: "list projection does not reflect a completed write",
		detail,
		evidence,
	})
}
