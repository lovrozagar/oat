import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { selectTerm } from "../../../../spec/conventions/select.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const selectRequestedFieldsPresent: Check<{
	requested: string[]
	projection: Record<string, string>
}> = defineCheck<{
	requested: string[]
	projection: Record<string, string>
}>({
	plan: (ctx) => {
		const requested = [
			ctx.identity,
			...(ctx.query?.selectable.filter((name) => name !== ctx.identity).slice(0, 2) ?? []),
		]
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		/* No projection to write without a select parameter, and nothing to ask for without a selectable field. */
		return projection === null || (ctx.query?.selectable.length ?? 0) === 0
			? cannot()
			: ready({ projection, requested })
	},
	dependsOn: ["select.projection-honored"],
	id: "select.requested-fields-present",
	lists: true,
	needs: "a select parameter and at least one selectable field",
	subjects: subjectsOf.list,
	async run(ctx, { projection, requested }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		if (result.exchange.status >= 400 || result.items[0] === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "select probe was rejected or empty")
		}
		const missing = requested.filter((name) => !Object.hasOwn(result.items[0] as object, name))
		if (missing.length === 0) return ASSERTED
		if (
			missing.length === 1 &&
			missing[0] === ctx.identity &&
			!(ctx.query?.selectable.includes(ctx.identity) ?? false)
		) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "identity was omitted from select and missing from items")
		}
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "a requested select field is missing from the projection",
			detail: `select=${requested.join(",")} omitted ${missing.join(", ")}.`,
			evidence: [result.exchange],
		})
	},
})
