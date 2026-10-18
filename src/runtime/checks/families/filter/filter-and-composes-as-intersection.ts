import { defineCheck } from "../../core/define.ts"
import { andTerm } from "../../../../spec/conventions.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { filterable, MOVING_FILTER } from "../../query/capabilities.ts"
import { type Compound, compoundPlan, readComposed } from "./compound.ts"

/**
 * Every filter check above uses a single predicate. Real filters compose them: `and(a,b)`,
 * `or(a,b)`, and nested combinations of both. This is the first of two checks giving that
 * combinator its own set-algebra property, needing no ground truth just like the rest: a
 * conjunction of two predicates must select exactly the intersection of what each selects alone.
 */
export const filterAndComposesAsIntersection = defineCheck<Compound>({
	plan: (ctx) => (filterable(ctx) && (ctx.query?.filterable.length ?? 0) > 1 ? compoundPlan(ctx, andTerm) : cannot()),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		/* Both sides are gathered across pages, so a walk that skips or repeats records changes
		 * the membership being compared for reasons unrelated to composition. */
		"pagination.page-walk-covers-set",
	],
	id: "filter.and-composes-as-intersection",
	needs: "two filterable fields and a filter parameter or grammar supporting eq",
	subjects: subjectsOf.list,
	async run(ctx, { combined, fieldA, fieldB, termA, termB, valueA, valueB }): Promise<Outcome> {
		const composed = await readComposed(
			ctx,
			{ combined, termA, termB },
			(a, b) => new Set([...a].filter((id) => b.has(id))),
		)
		if (composed === "rejected") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the intersection was rejected",
			)
		}
		if (composed === "incomplete") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the intersection cannot be verified",
			)
		}
		if (composed === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_FILTER)
		const { expected, extra, got, missing, onlyA, onlyB, setA, setB } = composed
		if (missing.length === 0 && extra.length === 0) return ASSERTED

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"and() does not compose as the intersection of its terms",
			`and(${fieldA}.eq.${valueA},${fieldB}.eq.${valueB}) returned ${got.size} record(s); ` +
				`${fieldA}.eq.${valueA} alone returned ${setA.size}, ${fieldB}.eq.${valueB} alone returned ` +
				`${setB.size}, whose intersection is ${expected.size}. ` +
				(missing.length > 0 ? `Missing from the combined result: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Present but should not match both terms: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"A conjunction must select exactly the records both terms match individually.",
			[onlyA.last.exchange, onlyB.last.exchange, composed.combined.last.exchange],
		)
	},
})
