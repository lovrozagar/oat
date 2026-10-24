import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { selectTerm } from "../../../../spec/conventions/select.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const selectProjection: Check<{
	requested: string[]
	projection: Record<string, string>
}> = defineCheck<{
	requested: string[]
	projection: Record<string, string>
}>({
	plan: (ctx) => {
		const requested = [ctx.identity]
		const extra = ctx.query?.selectable.find((f) => f !== ctx.identity)
		if (extra !== undefined) requested.push(extra)
		/* Through the grammar, not the bare parameter: JSON:API carries the resource type in the
		 * parameter *name*, so `select=` never reaches a backend expecting `fields[table]=`. */
		const projection = selectTerm(conv(ctx), requested, ctx.entityName)
		/* No projection to write without a select parameter, and none to observe without records. */
		return projection === null || ctx.records.length === 0 ? cannot() : ready({ projection, requested })
	},
	id: "select.projection-honored",
	lists: true,
	needs: "a `select` sparse-fieldset parameter",
	subjects: subjectsOf.list,
	async run(ctx, { projection, requested }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		const first = result.items[0]
		if (result.exchange.status >= 400 || first === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the projected listing was rejected or empty")
		const returned = Object.keys(first)
		const unexpected = returned.filter((key) => !requested.includes(key))
		if (unexpected.length === 0) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "sparse fieldset is accepted but ignored",
			detail:
				`select=${requested.join(",")} returned ${returned.length} fields, including ` +
				`${unexpected.slice(0, 5).join(", ")}. Accepting a projection and ignoring it silently ` +
				"inflates every response and leaks fields a caller deliberately excluded.",
			evidence: [result.exchange],
		})
	},
})
