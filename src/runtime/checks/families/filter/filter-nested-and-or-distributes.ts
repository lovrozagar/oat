import { defineCheck } from "../../core/define.ts"
import { filterSpec, filterTerm } from "../../../../spec/conventions/filter.ts"
import { renderAndOfOr } from "../../../../spec/render/filter-combine.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { NO_IDENTITY, subjectsOf } from "../../planning/subjects.ts"
import {
	conv,
	filterableNames,
	filterIdentity,
	FOUNDATIONS,
	identityIsFilterable,
	MOVING_FILTER,
} from "../../query/capabilities.ts"
import { readSettled, sameSet, setOf } from "../../sets/compare.ts"
import type { SetRead } from "../../sets/read.ts"
import { twoFilterableFields } from "./compound.ts"

export const filterNestedAndOrDistributes = defineCheck<{
	nested: Record<string, string>
	termA: Record<string, string>
	termB: Record<string, string>
	termC: Record<string, string>
}>({
	plan: (ctx) => {
		if (!filterSpec(conv(ctx)).mixed || filterableNames(ctx).length <= 1) return cannot()
		const picked = twoFilterableFields(ctx)
		if (picked === null) return cannot("a cohort record with values on two distinct filterable fields")
		const idField = filterIdentity(ctx)
		if (idField === picked.fieldA || idField === picked.fieldB || !identityIsFilterable(ctx)) {
			return cannot("a filterable identity as a third term to nest and/or")
		}
		const conventions = conv(ctx)
		const a = { field: picked.fieldA, op: "eq", value: String(picked.target[picked.fieldA]) } as const
		const b = { field: picked.fieldB, op: "eq", value: String(picked.target[picked.fieldB]) } as const
		const pickedId = idOf(picked.target, ctx.identity)
		if (pickedId === undefined) return cannot(NO_IDENTITY)
		const c = { field: idField, op: "eq", value: pickedId } as const
		const nested = renderAndOfOr(filterSpec(conventions), conventions.filter, a, [b, c])
		const termA = filterTerm(conventions, a.field, a.op, a.value)
		const termB = filterTerm(conventions, b.field, b.op, b.value)
		const termC = filterTerm(conventions, c.field, c.op, c.value)
		if (nested === null || termA === null || termB === null || termC === null) return cannot()
		return ready({ nested, termA, termB, termC })
	},
	dependsOn: [
		"query.filter-selects-from-whole-set",
		...FOUNDATIONS,
		"filter.and-composes-as-intersection",
		"filter.or-composes-as-union",
	],
	id: "filter.nested-and-or-distributes",
	needs: "a postgrest-shaped grammar and two filterable fields",
	subjects: subjectsOf.list,
	async run(ctx, { nested, termA, termB, termC }): Promise<Outcome> {
		const distributed = (a: SetRead, b: SetRead, c: SetRead): Set<string> => {
			const setB = setOf(b.items, ctx.identity)
			const setC = setOf(c.items, ctx.identity)
			return new Set([...setOf(a.items, ctx.identity)].filter((id) => setB.has(id) || setC.has(id)))
		}
		const reads = await readSettled(ctx, [termA, termB, termC, nested], (sets) => {
			const [a, b, c, n] = sets as [SetRead, SetRead, SetRead, SetRead]
			return sameSet(distributed(a, b, c), setOf(n.items, ctx.identity))
		})
		if (reads === "rejected")
			return ctx.findings.unresolved(this.id, ctx.entityName, "a nested and/or listing was rejected")
		if (reads === "incomplete") {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the collection is larger than the walk covers")
		}
		if (reads === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING_FILTER)
		/* One read per term, in the order the terms were given. */
		const [onlyA, onlyB, onlyC, combined] = reads as [SetRead, SetRead, SetRead, SetRead]
		const setA = setOf(onlyA.items, ctx.identity)
		const setB = setOf(onlyB.items, ctx.identity)
		const setC = setOf(onlyC.items, ctx.identity)
		const expected = new Set([...setA].filter((id) => setB.has(id) || setC.has(id)))
		const got = setOf(combined.items, ctx.identity)
		if (sameSet(expected, got)) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"and(A,or(B,C)) is not (A∩B) ∪ (A∩C)",
			`nested combinator returned ${got.size}; the distributed form is ${expected.size}.`,
			[combined.last.exchange, onlyA.last.exchange, onlyB.last.exchange, onlyC.last.exchange],
		)
	},
})
