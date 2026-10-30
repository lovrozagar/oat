import type { Check } from "../../core/check.ts"
import type { Listed } from "../../core/context.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import type { Exchange } from "../../../exchange.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { asProbe } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const malformedFilterNot5xx: Check = defineCheck({
	/* Malformed syntax needs a filter expression to be malformed in: per-field equality has none, and a
	 * request without one would pass for a refusal it never was. */
	plan: (ctx) => when(conv(ctx).filter !== undefined),
	id: "error.malformed-filter-not-5xx",
	lists: true,
	needs: "a filter expression parameter to send malformed syntax to",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const result = await list(asProbe(ctx), q(ctx, { filter: "((((", limit: 10 }))
		if (result.exchange.status >= 500)
			return crashed(ctx, this.id, { exchange: result.exchange, what: "a syntactically invalid filter" })
		if (result.exchange.status >= 300) return ASSERTED
		/* Garbage syntax dropped says nothing of how a refusal answers: a well-formed filter on a
		 * field the entity lacks still has to be refused, and is the one an API crashes on. */
		const unknown = filterTerm(conv(ctx), { field: "oat_no_such_field_xyz", op: "eq", value: 1 })
		const second = unknown === null ? undefined : await list(asProbe(ctx), { ...q(ctx, { limit: 10 }), ...unknown })
		if (second !== undefined && second.exchange.status >= 500) {
			return crashed(ctx, this.id, { exchange: second.exchange, what: "a filter on a field the entity does not have" })
		}
		if (second !== undefined && second.exchange.status >= 300) return ASSERTED
		return ctx.findings.unresolved(
			this.id,
			ctx.entityName,
			`the malformed filter was accepted (${result.exchange.status})` +
				(second === undefined ? "" : `, and so was one on an unknown field (${second.exchange.status})`) +
				", so whether a refused filter answers a 4xx is untested",
		)
	},
})

/* A filter the backend should refuse made it crash. */
function crashed(ctx: Listed, check: string, { exchange, what }: { exchange: Exchange; what: string }): Outcome {
	return ctx.findings.backend(check, ctx.entityName, {
		summary: "malformed filter input produces a server error",
		detail:
			`${what} returned ${exchange.status}. Bad client input must ` +
			"be rejected with a 4xx; a 5xx means the parser is throwing rather than validating.",
		evidence: [exchange],
	})
}
