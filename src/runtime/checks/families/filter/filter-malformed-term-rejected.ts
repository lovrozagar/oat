import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { filterSpec, filterTerm } from "../../../../spec/conventions/filter.ts"
import { renderMalformed } from "../../../../spec/render/filter-probe.ts"
import type { Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { asTermValue, conv, filterable, pageSize, q, resolvedCaps } from "../../query/capabilities.ts"
import { ids, list } from "../../sets/list.ts"

/**
 * A filter term missing a piece the declared grammar requires must be refused. Dropped instead,
 * the caller gets the whole collection back as though it matched.
 */
export const filterMalformedTermRejected: Check<{
	control: Record<string, string>
	field: string
	malformed: Record<string, string>
}> = defineCheck<{
	control: Record<string, string>
	field: string
	malformed: Record<string, string>
}>({
	plan: (ctx) => {
		const conventions = conv(ctx)
		if (conventions.grammarDeclared !== true || !filterable(ctx)) return cannot()
		for (const field of resolvedCaps(ctx).filterable) {
			const sample = ctx.records.find((row) => row[field.field] != null)
			const value = sample === undefined ? "oat-probe" : String(asTermValue(sample[field.field]))
			const malformed = renderMalformed({
				field: field.field,
				filterParam: conventions.filter,
				spec: filterSpec(conventions),
				value,
			})
			const control = filterTerm(conventions, { field: field.field, op: "eq", value })
			if (malformed !== null && control !== null) return ready({ control, field: field.field, malformed })
		}
		return cannot("a declared grammar whose terms carry a conjunction or an operator to leave out")
	},
	dependsOn: ["list.read-after-write", "filter.unknown-field-rejected", "error.malformed-filter-not-5xx"],
	id: "filter.malformed-term-rejected",
	needs: "a declared filter grammar whose terms carry a conjunction or an operator",
	subjects: subjectsOf.list,
	async run(ctx, { control, field, malformed }): Promise<Outcome> {
		const accepted = await list(ctx, { ...q(ctx, { limit: pageSize(ctx) }), ...control })
		if (accepted.exchange.status >= 400) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`a well-formed term on "${field}" was refused, so a malformed one proves nothing`,
			)
		}
		const result = await list(asProbe(ctx), { ...q(ctx, { limit: pageSize(ctx) }), ...malformed })
		if (result.exchange.status >= 500) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "a malformed filter term produces a server error",
				detail: `${Object.values(malformed).join("&")} returned ${result.exchange.status}; a rejected input should be 4xx.`,
				evidence: [result.exchange],
			})
		}
		const refused = judgeRefusal(ctx, this.id, ["validation"], result.exchange)
		if (refused !== null) return refused
		const baseline = await list(ctx, q(ctx, { limit: pageSize(ctx) }))
		const same = ids(result.items, ctx.identity).join(",") === ids(baseline.items, ctx.identity).join(",")
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "a malformed filter term is accepted",
			detail:
				`${Object.values(malformed).join("&")} returned ${result.exchange.status}` +
				(same ? " with the unfiltered set, so the term was dropped" : "") +
				". A term the declared grammar cannot parse must be rejected.",
			evidence: [baseline.exchange, result.exchange],
		})
	},
})
