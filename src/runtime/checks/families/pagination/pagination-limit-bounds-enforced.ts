import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, resolvedCaps } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

/**
 * A page size the document says is refused when out of range — `limitOutOfRange: reject` — must be
 * refused. Clamping is a fine contract too, which is why nothing is judged without the declaration.
 */
export const limitBoundsEnforced: Check<{ limitParam: string; max: number }> = defineCheck<{
	limitParam: string
	max: number
}>({
	plan: (ctx) => {
		const max = ctx.query?.maxLimit
		const limitParam = conv(ctx).limit
		if (resolvedCaps(ctx).limitOutOfRange !== "reject") return cannot("a declared limitOutOfRange: reject")
		if (max === undefined || limitParam === undefined) return cannot("a page-size parameter with a maximum")
		return ready({ limitParam, max })
	},
	dependsOn: ["pagination.limit-bounds-page-size"],
	id: "pagination.limit-bounds-enforced",
	needs: "a declared limitOutOfRange: reject, and a page size with a maximum",
	subjects: subjectsOf.list,
	async run(ctx, { limitParam, max }): Promise<Outcome> {
		for (const size of [0, max + 1]) {
			/* Deliberately out of range: these are the requests that may break the documented bound. */
			const result = await list(asProbe(ctx), { [limitParam]: size })
			if (result.exchange.status >= 500) {
				return ctx.findings.backend(this.id, ctx.entityName, {
					summary: "an out-of-range page size produces a server error",
					detail: `${limitParam}=${size} returned ${result.exchange.status}; a refused input should be 4xx.`,
					evidence: [result.exchange],
				})
			}
			const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
			/* Refused for the bound: try the other side. Turned away for another reason: nothing learned. */
			if (refused === ASSERTED) continue
			if (refused !== null) return refused
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "an out-of-range page size is served",
				detail:
					`${limitParam}=${size} returned ${result.exchange.status}; the document declares that a page size ` +
					`outside 1..${max} is refused.`,
				evidence: [result.exchange],
			})
		}
		return ASSERTED
	},
})
