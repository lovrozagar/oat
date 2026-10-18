import type { CheckContext } from "../core/context.ts"
import { cohortFact } from "../sets/compare.ts"
import { memoTable } from "../sets/read.ts"
import { resolvedCaps } from "./capabilities.ts"

/**
 * A sortable field whose values repeat across the cohort. Ties are what expose an unstable sort:
 * with distinct keys every implementation looks correct, because there is only one valid order.
 */
export function tiedSortField(ctx: CheckContext): string | null {
	return cohortFact(ctx, "tied-sort", () => computeTiedSortField(ctx))
}

function computeTiedSortField(ctx: CheckContext): string | null {
	for (const field of ctx.query?.sortable ?? []) {
		if (field === ctx.identity) continue
		const values = ctx.records.map((r) => JSON.stringify(r[field]))
		if (new Set(values).size < values.length) return field
	}
	return null
}

/**
 * A field that is null on some seeded records and populated on others.
 *
 * Null handling is where query engines break — SQL's three-valued logic means `col <> x` is NULL
 * rather than true for null rows, so they silently vanish from negated predicates, and
 * nullsfirst/nullslast is easy to get backwards. A check that only ever probes the identity
 * column, which is never null, cannot see any of it.
 */
export function nullableField(ctx: CheckContext, candidates: readonly string[]): string | null {
	return cohortFact(ctx, `nullable:${candidates.join(",")}`, () => computeNullableField(ctx, candidates))
}

function computeNullableField(ctx: CheckContext, candidates: readonly string[]): string | null {
	return candidates.find((field) => field !== ctx.identity && holdsSomeNulls(ctx, field)) ?? null
}

/** Null on some cohort records and set on others. */
export function holdsSomeNulls(ctx: CheckContext, field: string): boolean {
	const nulls = ctx.records.filter((row) => row[field] === null || row[field] === undefined).length
	return nulls > 0 && nulls < ctx.records.length
}

/** Numbers numerically, everything else by its text — the one ordering every collation shares on ids. */
export function compareScalars(a: unknown, b: unknown): number {
	if (typeof a === "number" && typeof b === "number") return a - b
	const as = String(a)
	const bs = String(b)
	return as < bs ? -1 : as > bs ? 1 : 0
}

/**
 * The ways a backend may order text. oat cannot know a backend's collation, so an order is
 * judged sorted when it is sorted under one of these — and, once the backend has shown which,
 * under that one from then on.
 */
const TEXT_ORDERS = {
	binary: (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0),
	folded: (a: string, b: string): number => {
		const x = a.toLowerCase()
		const y = b.toLowerCase()
		return x < y ? -1 : x > y ? 1 : 0
	},
	locale: (a: string, b: string): number => a.localeCompare(b),
} as const

type TextOrder = keyof typeof TEXT_ORDERS

const DECLARED_TEXT_ORDER = { binary: "binary", "case-insensitive": "folded", locale: "locale" } as const

/** How the backend has shown it orders each sort field: its text order and where nulls go. */
interface ObservedOrder {
	text: TextOrder
	nulls?: "first" | "last"
}

const isNull = (value: unknown): boolean => value === null || value === undefined

/**
 * The text order under which `values` — one sort field, in the order the backend returned them,
 * ascending — are sorted, or `null` when they are sorted under none.
 *
 * Collation-independent by construction: numbers must ascend numerically whatever the text
 * order, nulls must sit together at one end, and ties may come in any order. Text is held to the
 * order the backend already showed for this field when there is one, else to any of them.
 */
export function sortedUnder(ctx: CheckContext, field: string, values: readonly unknown[]): TextOrder | null {
	const present = values.filter((value) => !isNull(value))
	const { candidates, known } = orderInForce(ctx, field)
	if (!nullsPlaced(values, present.length, known?.nulls)) return null
	return candidates.find((order) => ascendingUnder(present, order)) ?? null
}

/**
 * What is known of how `field` is ordered — declared by the document, else shown by the backend —
 * and the text orders an order may still be judged under.
 */
function orderInForce(ctx: CheckContext, field: string): { candidates: TextOrder[]; known?: ObservedOrder } {
	const sortCaps = resolvedCaps(ctx).sort
	const observed = memoTable<ObservedOrder>(ctx.memo.entity, "textOrders").get(field)
	const known: ObservedOrder | undefined =
		sortCaps?.collation === undefined && sortCaps?.defaultNulls === undefined
			? observed
			: {
					text:
						sortCaps.collation === undefined ? (observed?.text ?? "binary") : DECLARED_TEXT_ORDER[sortCaps.collation],
					...(sortCaps.defaultNulls === undefined ? {} : { nulls: sortCaps.defaultNulls }),
				}
	const candidates: TextOrder[] =
		known === undefined || (sortCaps?.collation === undefined && observed === undefined)
			? ["binary", "folded", "locale"]
			: [known.text]
	return known === undefined ? { candidates } : { candidates, known }
}

/** Nulls together at one end — and the same end every time once one has been seen. */
function nullsPlaced(values: readonly unknown[], present: number, end: ObservedOrder["nulls"]): boolean {
	const nulls = values.length - present
	if (nulls === 0 || present === 0) return true
	const first = values.slice(0, nulls).every(isNull)
	const last = values.slice(present).every(isNull)
	if (!first && !last) return false
	if (end === "first" && !first) return false
	return end !== "last" || last
}

/** Whether `present` ascends under `order`: numbers numerically, text under that order, ties either way. */
function ascendingUnder(present: readonly unknown[], order: TextOrder): boolean {
	const text = TEXT_ORDERS[order]
	return present.every((value, index) => {
		if (index === 0) return true
		const prior = present[index - 1]
		if (typeof prior === "number" && typeof value === "number") return prior <= value
		return text(String(prior), String(value)) <= 0
	})
}

/** Records how the backend ordered `field`, so later checks hold it to the same order. */
export function observeTextOrder(ctx: CheckContext, field: string, text: TextOrder, values: readonly unknown[]): void {
	const orders = memoTable<ObservedOrder>(ctx.memo.entity, "textOrders")
	if (orders.has(field)) return
	const nulls =
		values.some(isNull) && values.some((value) => !isNull(value))
			? isNull(values[0])
				? ("first" as const)
				: ("last" as const)
			: undefined
	orders.set(field, nulls === undefined ? { text } : { nulls, text })
}
