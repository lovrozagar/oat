import { type andTerm, filterTerm } from "../../../../spec/conventions/filter.ts"
import type { FilterQuery } from "../../../../spec/render/filter-types.ts"
import type { Record_ } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, type Plan, ready } from "../../core/plan.ts"
import { conv, filterableNames, filterIdentity, pageSize } from "../../query/capabilities.ts"
import { cohortFact, collectSet, membership } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import type { SetRead } from "../../sets/read.ts"

/** The three reads a combinator check compares, and what they say. */
interface Composed {
	combined: SetRead
	expected: Set<string>
	extra: string[]
	got: Set<string>
	missing: string[]
	onlyA: SetRead
	onlyB: SetRead
	setA: Set<string>
	setB: Set<string>
}

/**
 * Reads each term alone and then combined. A disagreement is read again: when any of the three
 * reads now holds other rows, another writer moved the collection between them — a record created
 * after the term reads and before the combined one — and that is no defect of composition. Only a
 * disagreement the fresh reads repeat is the backend's.
 */
export async function readComposed(
	ctx: CheckContext,
	terms: { combined: FilterQuery; termA: Record<string, string>; termB: Record<string, string> },
	compose: (setA: Set<string>, setB: Set<string>) => Set<string>,
): Promise<Composed | "rejected" | "incomplete" | "moving"> {
	const limit = pageSize(ctx)
	const read = async (fresh: boolean): Promise<Composed | "rejected" | "incomplete"> => {
		const onlyA = await collectSet(ctx, limit, terms.termA, { fresh })
		const onlyB = await collectSet(ctx, limit, terms.termB, { fresh })
		const combined = await collectSet(ctx, limit, terms.combined, { fresh })
		if (onlyA === null || onlyB === null || combined === null) return "rejected"
		if (!onlyA.complete || !onlyB.complete || !combined.complete) return "incomplete"
		const setA = new Set(ids(onlyA.items, ctx.identity))
		const setB = new Set(ids(onlyB.items, ctx.identity))
		const expected = compose(setA, setB)
		const got = new Set(ids(combined.items, ctx.identity))
		const missing = [...expected].filter((id) => !got.has(id))
		const extra = [...got].filter((id) => !expected.has(id))
		return { combined, expected, extra, got, missing, onlyA, onlyB, setA, setB }
	}
	const first = await read(false)
	if (typeof first === "string" || (first.missing.length === 0 && first.extra.length === 0)) return first
	const again = await read(true)
	if (typeof again === "string") return again
	const same = (a: SetRead, b: SetRead) => membership(a.items, ctx.identity) === membership(b.items, ctx.identity)
	if (!same(first.onlyA, again.onlyA) || !same(first.onlyB, again.onlyB) || !same(first.combined, again.combined)) {
		return "moving"
	}
	return again
}

/**
 * Finds a record holding non-null values on two distinct, non-identity filterable fields — the
 * minimum needed to build a compound predicate that is guaranteed to match at least that record.
 */
export function twoFilterableFields(ctx: CheckContext): { fieldA: string; fieldB: string; target: Record_ } | null {
	return cohortFact(ctx, "two-filterable", () => computeTwoFilterableFields(ctx))
}

function computeTwoFilterableFields(ctx: CheckContext): { fieldA: string; fieldB: string; target: Record_ } | null {
	const skip = new Set([ctx.identity, filterIdentity(ctx)])
	const candidates = filterableNames(ctx).filter((f) => !skip.has(f))
	for (const target of ctx.records) {
		const present = candidates.filter((f) => target[f] !== null && target[f] !== undefined)
		if (present[0] !== undefined && present[1] !== undefined) {
			return { fieldA: present[0], fieldB: present[1], target }
		}
	}
	return null
}

/** Two equality predicates on one record, and the two combined. */
export interface Compound {
	fieldA: string
	fieldB: string
	valueA: string
	valueB: string
	termA: Record<string, string>
	termB: Record<string, string>
	combined: FilterQuery
}

export function compoundPlan(
	ctx: CheckContext,
	/* `andTerm` or `orTerm`: both render two equalities joined by their combinator. */
	combine: typeof andTerm,
): Plan<Compound> {
	const picked = twoFilterableFields(ctx)
	if (picked === null) return cannot("a cohort record with values on two distinct filterable fields")
	const conventions = conv(ctx)
	const { fieldA, fieldB, target } = picked
	const valueA = String(target[fieldA])
	const valueB = String(target[fieldB])
	const termA = filterTerm(conventions, fieldA, "eq", valueA)
	const termB = filterTerm(conventions, fieldB, "eq", valueB)
	const combined = combine(conventions, { field: fieldA, value: valueA }, { field: fieldB, value: valueB })
	if (termA === null || termB === null || combined === null) {
		return cannot("a filter grammar that can express a combined predicate")
	}
	return ready({ combined, fieldA, fieldB, termA, termB, valueA, valueB })
}
