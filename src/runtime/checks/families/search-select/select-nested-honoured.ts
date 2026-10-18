import { defineCheck } from "../../core/define.ts"
import { selectTerm } from "../../../../spec/conventions/select.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { Record_ } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, q, resolvedCaps } from "../../query/capabilities.ts"
import { list } from "../../sets/list.ts"

export const selectNestedHonoured = defineCheck<{
	relation: { name: string; fields: string[] }
	first: string
	projection: Record<string, string>
}>({
	plan: (ctx) => {
		if (resolvedCaps(ctx).select?.nested !== true) return cannot()
		const relation = resolvedCaps(ctx).select?.relations?.[0]
		const first = relation?.fields[0]
		if (relation === undefined || first === undefined) return cannot()
		const projection = selectTerm(conv(ctx), [ctx.identity, `${relation.name}(${first})`], ctx.entityName)
		return projection === null ? cannot() : ready({ first, projection, relation })
	},
	dependsOn: ["select.projection-honoured"],
	id: "select.nested-honoured",
	needs: "select.nested and a named relation",
	subjects: subjectsOf.list,
	async run(ctx, { first, projection, relation }): Promise<Outcome> {
		const result = await list(ctx, { ...q(ctx, { limit: 5 }), ...projection })
		if (result.exchange.status >= 400 || result.items[0] === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "nested select was rejected or empty")
		}
		/* A to-one relation comes back as an object, a to-many one as an array of them, and a
		 * record with no related row as null — which says nothing about the projection. */
		const related: Record_[] = []
		for (const item of result.items) {
			const nested = item[relation.name]
			if (nested === null || nested === undefined) continue
			const rows = Array.isArray(nested) ? nested : [nested]
			const scalar = rows.find((row) => row === null || typeof row !== "object" || Array.isArray(row))
			if (scalar !== undefined) {
				return ctx.findings.backend(this.id, ctx.entityName, {
					summary: "nested select did not return the relation as records",
					detail: `select=${relation.name}(${first}) left "${relation.name}" holding ${JSON.stringify(scalar)}.`,
					evidence: [result.exchange],
				})
			}
			related.push(...(rows as Record_[]))
		}
		if (related.length === 0) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `no listed record has a "${relation.name}" to project`)
		}
		const keys = [...new Set(related.flatMap((row) => Object.keys(row)))]
		if (keys.every((key) => key === first)) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "nested select did not restrict the relation to the requested field",
			detail: `select=${relation.name}(${first}) returned ${keys.join(", ")}.`,
			evidence: [result.exchange],
		})
	},
})
