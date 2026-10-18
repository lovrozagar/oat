import { defineCheck } from "../../core/define.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { declarationAnswer } from "../../planning/declarations.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q, resolvedCaps } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const searchModeAccepted = defineCheck({
	plan: (ctx) =>
		when(
			conv(ctx).searchMode !== undefined &&
				(resolvedCaps(ctx).searchModes?.length ?? 0) > 0 &&
				conv(ctx).search !== undefined,
		),
	id: "search.mode-accepted",
	needs: "declared searchModes and a search-mode parameter",
	subjects: subjectsOf.list,
	async run(ctx): Promise<Outcome> {
		const rejected: string[] = []
		const refusedBy: Exchange[] = []
		const unknown: string[] = []
		for (const mode of resolvedCaps(ctx).searchModes ?? []) {
			const result = await list(ctx, q(ctx, { limit: 5, search: "oat", searchMode: mode }))
			const answer = declarationAnswer(result.exchange.status)
			if (answer === "refused") {
				refusedBy.push(result.exchange)
				rejected.push(`${mode} (${result.exchange.status})`)
			}
			if (answer === "unknown") unknown.push(`${mode} (${result.exchange.status})`)
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
			"a declared search mode is rejected",
			`rejected: ${rejected.join(", ")}.`,
			refusedBy.slice(0, 3),
		)
	},
})
