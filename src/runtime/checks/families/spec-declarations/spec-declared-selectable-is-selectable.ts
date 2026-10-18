import { defineCheck } from "../../core/define.ts"
import { selectTerm } from "../../../../spec/conventions.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { declarationAnswer } from "../../planning/declarations.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

/**
 * The select analogue of `declaredFilterableWorks` and `declaredSortableWorks`:
 * `x-query.selectable` is a promise too, and a sparse fieldset the backend rejects breaks every
 * client generated from the document exactly the same way a rejected filter or sort does.
 */
export const declaredSelectableWorks = defineCheck({
	plan: (ctx) =>
		when(
			conv(ctx).select !== undefined &&
				ctx.query?.source === "tag" &&
				(ctx.query?.selectable.length ?? 0) > 0 &&
				ctx.records.length > 0,
		),
	dependsOn: [
		"list.read-after-write",
		/* Same masking risk as the filter and sort overclaim checks: ERROR_500_ON_BAD_FILTER turns
		 * any rejection — this one included — into a 500, which would fall outside the 4xx window
		 * below and read as accepted. */
		"error.malformed-filter-not-5xx",
		/* Same shape as the sort check's dependency on sort.order-is-applied, found by inspection
		 * before the fuzzer had to: `project()` returns the row untouched under SELECT_IGNORED
		 * *before* the excluded-field check runs, so a backend that has stopped honouring `select`
		 * at all also stops rejecting an overclaimed field — the request just returns every column. */
		"select.projection-honoured",
	],
	id: "spec.declared-selectable-is-selectable",
	needs: "x-query naming selectable fields",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const conventions = conv(ctx)
		const rejected: Array<{ field: string; status: number; exchange: Exchange }> = []
		const unknown: string[] = []
		let probed = 0

		const answers = await Promise.all(
			(ctx.query?.selectable ?? []).map(async (field) => {
				const projection = selectTerm(conventions, [ctx.identity, field], ctx.entityName)
				if (projection === null) return null
				return { field, result: await list(ctx, { ...q(ctx, { limit: 5 }), ...projection }) }
			}),
		)
		for (const answered of answers) {
			if (answered === null) continue
			const { field, result } = answered
			probed += 1
			/* Only a rejection counts. A field accepted and then ignored is select.projection-
			 * honoured's finding, not a capability claim breaking. */
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") rejected.push({ exchange: result.exchange, field, status: result.exchange.status })
			if (answer === "unknown") unknown.push(`${field} (${result.exchange.status})`)
		}

		if (probed === 0) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "no declared selectable field could be probed")
		}
		if (rejected.length === 0 && unknown.length > 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`probes were turned away without a verdict: ${unknown.join(", ")}`,
			)
		}
		if (rejected.length === 0) return ASSERTED

		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"the document declares a select field the backend does not accept",
			`x-query lists ${rejected.length} field(s) as selectable that the backend rejects: ` +
				`${rejected.map((r) => `${r.field} (${r.status})`).join(", ")}. ` +
				"Every client generated from this document will offer a sparse fieldset that fails at " +
				"runtime. Either the field needs to stay projectable or the declaration needs " +
				"removing — but the document and the backend currently disagree about what this API " +
				"can do.",
			rejected.slice(0, 3).map((item) => item.exchange),
		)
	},
})
