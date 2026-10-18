import { defineCheck } from "../../core/define.ts"
import { sortTerm } from "../../../../spec/conventions/sort.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { Record_ } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, MOVING, pageSize } from "../../query/capabilities.ts"
import { nullableField } from "../../query/order.ts"
import { collectSet, settlePair } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import type { SetRead } from "../../sets/read.ts"

export const sortReverseSymmetry = defineCheck<{ field: string }>({
	plan: (ctx) => {
		if (ctx.records.length <= 1) return cannot()
		/* A nullable sort key exercises null ordering, where the interesting bugs live. */
		const field =
			nullableField(ctx, ctx.query?.sortable ?? []) ??
			ctx.query?.sortable.find((f) => f !== ctx.identity) ??
			ctx.query?.sortable[0]
		return field === undefined ? cannot() : ready({ field })
	},
	/* The property is asserted over a *nullable* sort key, because that is where null-ordering
	 * bugs live. A backend that drops submitted fields leaves that column uniformly null, and a
	 * sort over one repeated value is symmetric no matter how badly the backend sorts. */
	dependsOn: [
		"create.persists-submitted-fields",
		/* Reversing an order that is never applied returns the same page twice. Every sort
		 * property is untestable until ordering itself is known to work. */
		"sort.order-is-applied",
		/* Both directions are gathered across pages, so a walk that skips or repeats records
		 * changes the membership this check compares — for reasons that are not about sorting. */
		"pagination.page-walk-covers-set",
	],
	id: "sort.reverse-symmetry",
	needs: "an `order` parameter supporting asc and desc",
	subjects: subjectsOf.list,
	async run(ctx, { field }): Promise<Outcome> {
		const limit = pageSize(ctx)
		/* Gathered across pages: a collection larger than one page would otherwise leave this
		 * property — that a reversal reorders a set without changing its membership — untested on
		 * exactly the collections where sorting matters most. */
		const ascending = await collectSet(ctx, limit, {}, { order: sortTerm(conv(ctx), field, "asc") })
		const descending = await collectSet(ctx, limit, {}, { order: sortTerm(conv(ctx), field, "desc") })
		if (ascending === null || descending === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`ordering by "${field}" was rejected in one direction, so the two cannot be compared`,
			)
		}

		/* Only comparable when a single page holds the whole collection. Otherwise asc and desc
		 * return opposite *windows* of it — legitimately different sets, and comparing them would
		 * report every capped collection as broken. */
		if (!ascending.complete || !descending.complete) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the collection is larger than the walk covers, so the two directions return " +
					"different windows of it rather than the same set reversed",
			)
		}

		const settled = await settlePair(ctx.identity, ascending, descending, {
			first: () => collectSet(ctx, limit, {}, { order: sortTerm(conv(ctx), field, "asc"), fresh: true }),
			second: () => collectSet(ctx, limit, {}, { order: sortTerm(conv(ctx), field, "desc"), fresh: true }),
		})
		if (settled === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING)
		if (settled === null) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `ordering by "${field}" was rejected on a repeat read`)
		}
		return judgeReversal(ctx, this.id, field, settled)
	},
})

/* The listed values of `field`, nulls left out, as comparable text. */
function presentValues(items: Record_[], field: string): string[] {
	return items
		.map((item) => item[field])
		.filter((value) => value !== null && value !== undefined)
		.map((value) => JSON.stringify(value))
}

/** Whether a settled descending read is the ascending one reversed, up to ties and nulls. */
function judgeReversal(
	ctx: CheckContext,
	check: string,
	field: string,
	{ first: ascending, second: descending }: { first: SetRead; second: SetRead },
): Outcome {
	const forward = ids(ascending.items, ctx.identity)
	const backward = ids(descending.items, ctx.identity)
	if (forward.length !== backward.length) {
		return ctx.findings.backend(
			check,
			ctx.entityName,
			"ascending and descending sorts return different numbers of records",
			`order=${field}.asc returned ${forward.length}, order=${field}.desc returned ${backward.length}`,
			[ascending.last.exchange, descending.last.exchange],
		)
	}
	if (forward.join(",") === backward.toReversed().join(",")) return ASSERTED

	/* Values may legitimately tie; only flag when the multisets differ or a strict field
	 * ordering is violated, not when equal keys land in a different arrangement. */
	const sameMembers = [...forward].sort().join(",") === [...backward].sort().join(",")
	if (!sameMembers) {
		const onlyAsc = forward.filter((id) => !backward.includes(id))
		const onlyDesc = backward.filter((id) => !forward.includes(id))
		ctx.findings.backend(
			check,
			ctx.entityName,
			"ascending and descending sorts return different sets",
			`order=${field}.asc and order=${field}.desc disagree about which records exist. ` +
				`Only ascending: ${onlyAsc.slice(0, 3).join(", ") || "—"}. ` +
				`Only descending: ${onlyDesc.slice(0, 3).join(", ") || "—"}. ` +
				"Sort direction must reorder a collection, never change its membership.",
			[ascending.last.exchange, descending.last.exchange],
		)
		return ASSERTED
	}
	/* Up to ties, descending is ascending reversed — whatever the collation, since both come
	 * from the same backend. Compared by value, so tied records may land in any arrangement;
	 * nulls are left out, as either end is a legitimate place for them in either direction. */
	const up = presentValues(ascending.items, field)
	const down = presentValues(descending.items, field)
	if (up.join("\u0000") === down.toReversed().join("\u0000")) return ASSERTED
	return ctx.findings.backend(
		check,
		ctx.entityName,
		"descending order is not ascending order reversed",
		`order=${field}.asc gives ${up.slice(0, 4).join(", ")}…, but order=${field}.desc reversed gives ` +
			`${down.toReversed().slice(0, 4).join(", ")}…. One direction applies a different ordering than the other.`,
		[ascending.last.exchange, descending.last.exchange],
	)
}
