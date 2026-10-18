import { defineCheck } from "../../core/define.ts"
import { sortTermWithNulls } from "../../../../spec/conventions.ts"
import { fieldAllowsNulls } from "../../../../spec/query-capabilities.ts"
import type { Exchange } from "../../../client.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { declarationAnswer } from "../../planning/declarations.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q, resolvedCaps } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const declaredSortableNullsAccepted = defineCheck({
	plan: (ctx) =>
		when(
			conv(ctx).order !== undefined &&
				sortTermWithNulls(conv(ctx), "x", "asc", "first") !== null &&
				resolvedCaps(ctx).sortable.some(
					(field) =>
						fieldAllowsNulls(field, resolvedCaps(ctx), "first") || fieldAllowsNulls(field, resolvedCaps(ctx), "last"),
				),
		),
	dependsOn: ["sort.order-is-applied"],
	id: "spec.declared-sortable-nulls-accepted",
	needs: "a declared nulls token on a sortable field",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const rejected: string[] = []
		const refusedBy: Exchange[] = []
		const unknown: string[] = []
		for (const field of resolvedCaps(ctx).sortable) {
			for (const token of ["first", "last"] as const) {
				if (!fieldAllowsNulls(field, resolvedCaps(ctx), token)) continue
				const clause = sortTermWithNulls(conv(ctx), field.field, "asc", token)
				if (clause === null) continue
				const result = await list(ctx, q(ctx, { limit: 5, order: clause }))
				const answer = declarationAnswer(result.exchange.status)
				if (answer === "refused") {
					refusedBy.push(result.exchange)
					rejected.push(`${clause} (${result.exchange.status})`)
				}
				if (answer === "unknown") unknown.push(`${clause} (${result.exchange.status})`)
			}
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
			"the document declares a nulls sort token the backend rejects",
			`rejected: ${rejected.join(", ")}.`,
			refusedBy.slice(0, 3),
		)
	},
})
