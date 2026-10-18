import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions.ts"
import type { EffectiveFilterField } from "../../../../spec/query-capabilities.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, resolvedCaps } from "../../query/capabilities.ts"
import { cohortFact } from "../../sets/compare.ts"
import { readSet } from "../../sets/read.ts"

function numericLexicalDisagrees(ctx: CheckContext, field: string): boolean {
	return cohortFact(ctx, `numeric-lexical:${field}`, () => computeNumericLexicalDisagrees(ctx, field))
}

function computeNumericLexicalDisagrees(ctx: CheckContext, field: string): boolean {
	const values = ctx.records.map((row) => row[field]).filter((v): v is number => typeof v === "number")
	if (values.length < 3) return false
	const unique = [...new Set(values)]
	const asNumbers = [...unique].sort((a, b) => a - b)
	const asText = [...unique].sort((a, b) => String(a).localeCompare(String(b)))
	return asNumbers.join(",") !== asText.join(",")
}

export const sortNumericOrderIsNumeric = /* @__PURE__ */ defineCheck<{ field: EffectiveFilterField }>({
	plan: (ctx) => {
		const field = resolvedCaps(ctx).sortable.find((item) => numericLexicalDisagrees(ctx, item.field))
		return conv(ctx).order === undefined || field === undefined ? cannot() : ready({ field })
	},
	dependsOn: ["sort.order-is-applied", "pagination.page-walk-covers-set"],
	id: "sort.numeric-order-is-numeric",
	needs: "a numeric sortable field whose lexical order disagrees with numeric order",
	subjects: subjectsOf.list,
	async run(ctx, { field }): Promise<Outcome> {
		/* Across pages: a server that serves a few rows at a time can put the disagreeing values on
		 * different pages. Even a read cut short is a prefix of the order, and must ascend. */
		const read = await readSet(ctx, {}, { order: sortTerm(conv(ctx), field.field, "asc") })
		if (read.status !== "ok") return ctx.findings.unresolved(this.id, ctx.entityName, read.reason)
		const numbers = read.items.map((item) => item[field.field]).filter((v): v is number => typeof v === "number")
		const sorted = [...numbers].sort((a, b) => a - b)
		if (numbers.join(",") === sorted.join(",")) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			`"${field.field}" is sorted as text rather than as a number`,
			`order=${field.field}.asc returned ${numbers.slice(0, 8).join(", ")}.`,
			read.pages.slice(0, 3).map((page) => page.exchange),
		)
	},
})
