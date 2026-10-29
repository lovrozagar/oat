import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { filterSpec, orTerm } from "../../../../spec/conventions/filter.ts"
import { canWriteOr } from "../../../../spec/render/filter-term.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, MOVING_COLLECTION } from "../../query/capabilities.ts"
import { type Compound, compoundPlan, readComposed } from "./compound.ts"

/**
 * The disjunction counterpart of `filterAndComposesAsIntersection`: `or(a,b)` must select
 * exactly the union of what each predicate selects alone. Only the postgrest-shaped grammar has
 * an `or()` combinator at all — per-field equality and the colon grammar's comma join are both
 * AND-only — so this stands down everywhere else rather than inventing a request to send.
 */
export const filterOrComposesAsUnion: Check<Compound> = defineCheck<Compound>({
	plan: (ctx) =>
		canWriteOr(filterSpec(conv(ctx))) && (ctx.query?.filterable.length ?? 0) > 1 ? compoundPlan(ctx, orTerm) : cannot(),
	dependsOn: [
		"query.filter-selects-from-whole-set",
		"list.read-after-write",
		"create.persists-submitted-fields",
		"filter.equality-selects-exactly-one",
		"pagination.page-walk-covers-set",
		/* Deliberately does *not* depend on filter.and-composes-as-intersection: and() and or()
		 * being broken by the same defect is two independent manifestations of one root cause, not
		 * one causing the other. A defect that swaps the combinators corrupts both requests, and
		 * suppressing this as and()'s cascade would hide the half of the bug this check is the
		 * only thing that can see. */
	],
	id: "filter.or-composes-as-union",
	lists: true,
	needs: "two filterable fields and an or() combinator (postgrest-shaped filter grammar)",
	subjects: subjectsOf.list,
	async run(ctx, { combined, fieldA, fieldB, termA, termB, valueA, valueB }): Promise<Outcome> {
		const composed = await readComposed(ctx, { combined, termA, termB }, (a, b) => new Set([...a, ...b]))
		if (composed === "rejected") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the three listings needed for the union was rejected",
			)
		}
		if (composed === "incomplete") {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the union cannot be verified",
			)
		}
		if (composed === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_COLLECTION)
		const { expected, extra, got, missing, onlyA, onlyB, setA, setB } = composed
		if (missing.length === 0 && extra.length === 0) return ASSERTED

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "or() does not compose as the union of its terms",
			detail:
				`or(${fieldA}.eq.${valueA},${fieldB}.eq.${valueB}) returned ${got.size} record(s); ` +
				`${fieldA}.eq.${valueA} alone returned ${setA.size}, ${fieldB}.eq.${valueB} alone returned ` +
				`${setB.size}, whose union is ${expected.size}. ` +
				(missing.length > 0 ? `Missing from the combined result: ${missing.slice(0, 3).join(", ")}. ` : "") +
				(extra.length > 0 ? `Present but matches neither term individually: ${extra.slice(0, 3).join(", ")}. ` : "") +
				"A disjunction must select exactly the records either term matches alone.",
			evidence: [onlyA.last.exchange, onlyB.last.exchange, composed.combined.last.exchange],
		})
	},
})
