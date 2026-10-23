import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import type { Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q } from "../../query/capabilities.ts"
import { ids, list } from "../../sets/list.ts"

export const unknownFilterRejected: Check<{ unknownField: Record<string, string> }> = defineCheck<{
	unknownField: Record<string, string>
}>({
	/*
	 * Deliberately narrower than `filterable`: this asserts that a *filter expression* naming a
	 * field the document does not declare is rejected rather than dropped.
	 *
	 * Under one-parameter-per-field equality there is no expression language, so an unrecognised
	 * parameter is just an unrecognised query parameter — and ignoring those is conventional,
	 * widely relied upon, and not a defect. Reporting it as one would fire against a large share
	 * of real APIs, which is how a tool earns a reputation for crying wolf.
	 */
	plan: (ctx) => {
		const unknownField =
			conv(ctx).filter === undefined
				? null
				: filterTerm(conv(ctx), { field: "oat_no_such_field_xyz", op: "eq", value: 1 })
		return unknownField === null ? cannot() : ready({ unknownField })
	},
	id: "filter.unknown-field-rejected",
	needs: "a way to express a filter — a filter expression parameter, or filterable fields",
	subjects: subjectsOf.list,
	async run(ctx, { unknownField }): Promise<Outcome> {
		const baseline = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: pageSize(ctx) }), ...unknownField })

		if (result.exchange.status >= 500) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "unknown filter field produces a server error",
				detail: `filtering on an undeclared field returned ${result.exchange.status}; a rejected input should be a 4xx`,
				evidence: [result.exchange],
			})
		}
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused

		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "unknown filter field is silently ignored",
			detail:
				`filtering on an undeclared field returned ${result.exchange.status} with ` +
				`${result.items.length} of ${baseline.items.length} records` +
				(same ? " — identical to the unfiltered result, so the filter was dropped entirely" : "") +
				". A filter the backend does not understand must be rejected, never ignored: silently " +
				"ignoring it means every caller's filter may be doing nothing.",
			evidence: [baseline.exchange, result.exchange],
		})
	},
})
