import { defineCheck } from "../../core/define.ts"
import { canWriteFilterOp, filterTerm } from "../../../../spec/conventions/filter.ts"
import type { EffectiveFilterField } from "../../../../spec/query/effective.ts"
import { fieldAllows } from "../../../../spec/query/field-ops.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { asTermValue, conv, FOUNDATIONS, pageSize, resolvedCaps, schemaType } from "../../query/capabilities.ts"
import { collectSet, sameSet } from "../../sets/compare.ts"
import { knownHits } from "./fields.ts"

/** An array field membership can be asked of, with a known element — one rule for both phases. */
function containsField(ctx: CheckContext): EffectiveFilterField | undefined {
	return resolvedCaps(ctx).filterable.find(
		(field) =>
			(field.type === "array" ||
				schemaType(ctx, field.field) === "array" ||
				fieldAllows(field, "contains", resolvedCaps(ctx))) &&
			canWriteFilterOp(conv(ctx), "contains") &&
			ctx.records.some((row) => Array.isArray(row[field.field]) && (row[field.field] as unknown[]).length > 0),
	)
}

export const filterContainsMembership = defineCheck<{
	field: EffectiveFilterField
	element: string
	term: Record<string, string>
}>({
	plan: (ctx) => {
		const field = containsField(ctx)
		if (field === undefined) return cannot()
		/* The most telling element is one that also occurs inside another element's text: an
		 * implementation matching the serialised array instead of its members over-selects there. */
		const elements = [
			...new Set(
				ctx.records.flatMap((row) => (Array.isArray(row[field.field]) ? (row[field.field] as unknown[]) : [])),
			),
		].map(String)
		/* `containsField` found a record holding an element, so there is a first one. */
		const element =
			elements.find((candidate) => elements.some((other) => other !== candidate && other.includes(candidate))) ??
			(elements[0] as string)
		const term = filterTerm(conv(ctx), { field: field.field, op: "contains", value: asTermValue(element) })
		return term === null ? cannot("a filter grammar with a contains operator") : ready({ element, field, term })
	},
	dependsOn: [...FOUNDATIONS, "query.filter-selects-from-whole-set"],
	id: "filter.contains-membership",
	needs: "an array field that allows `contains` and a known element",
	subjects: subjectsOf.list,
	async run(ctx, { element, field, term }): Promise<Outcome> {
		const result = await collectSet(ctx, pageSize(ctx), term)
		if (result === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "contains probe was rejected")
		}
		if (!result.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		const expected = new Set(
			ctx.records
				.filter(
					(row) =>
						Array.isArray(row[field.field]) &&
						(row[field.field] as unknown[]).some((item) => String(item) === String(element)),
				)
				.flatMap((row) => idOf(row, ctx.identity) ?? []),
		)
		const got = knownHits(result.items, ctx)
		if (sameSet(expected, got)) return ASSERTED
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "contains does not select membership of the given element",
			detail: `${field.field}.contains.${String(element)} returned ${got.size}; ${expected.size} records hold that element.`,
			evidence: [result.last.exchange],
		})
	},
})
