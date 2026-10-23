import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, asserted, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"

/**
 * Paging parameters at and past their bounds: a page size of zero, a negative one, one that is
 * not a whole number, and a page past the end of the collection.
 *
 * Refusing an out-of-range size and serving a sane one are both fine; crashing is not. A page
 * past the end must hold nothing — a server that serves the last page again there makes every
 * client that pages until an empty page loop forever.
 */
export const paginationBoundsHandled: Check<{
	limit: string | undefined
	page: string | undefined
}> = defineCheck<{
	limit: string | undefined
	page: string | undefined
}>({
	plan: (ctx) => {
		const { limit, page } = conv(ctx)
		if ((limit === undefined && page === undefined) || ctx.records.length === 0) return cannot()
		return ready({ limit, page })
	},
	dependsOn: ["list.read-after-write", "pagination.page-walk-covers-set"],
	id: "pagination.bounds-handled",
	lists: true,
	needs: "a page-size or page-number parameter, and at least one record",
	subjects: subjectsOf.list,
	async run(ctx, { limit, page }): Promise<Outcome> {
		if (limit !== undefined) {
			for (const value of ["0", "-1", "2.5", "abc"]) {
				const result = await list(asProbe(ctx), { [limit]: value })
				if (result.exchange.status >= 500) {
					return ctx.findings.backend(this.id, ctx.entityName, {
						summary: `a page size of ${value} crashes the listing`,
						detail:
							`?${limit}=${value} returned ${result.exchange.status}; an out-of-range page size must be ` +
							"refused with a 4xx, or served as a sane size.",
						evidence: [result.exchange],
					})
				}
			}
		}
		if (page === undefined) return ASSERTED
		const whole = await readSet(ctx, {}, { fresh: true })
		if (whole.status !== "ok" || !whole.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, whole.reason)
		}
		const size = pageSize(ctx)
		/* Past the end at any page size a server may serve — it may clamp below the size asked for,
		 * so a page number from the requested size could still fall inside the set. */
		const beyond = whole.items.length + 2
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: size }), [page]: beyond })
		const status = result.exchange.status
		if (status >= 500) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "a page past the end crashes the listing",
				detail: `?${page}=${beyond}, past the last of ${whole.items.length} record(s), returned ${status}.`,
				evidence: [result.exchange],
			})
		}
		if (status >= 400) return asserted(`a page past the end is refused (${status})`)
		if (result.items.length === 0) return asserted("a page past the end is served empty")
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "a page past the end of the collection returns records",
			detail:
				`?${page}=${beyond} lies past the last of ${whole.items.length} record(s) at ${size} per page, ` +
				`yet returned ${result.items.length}. A client that pages until an empty page never stops.`,
			evidence: [whole.last.exchange, result.exchange],
		})
	},
})
