import type { DefectSet } from "../defects/defect-set.ts"
import type { EntityDef } from "../model/types.ts"
import type { ParseContext } from "../query/conventions.ts"
import { parseOrder } from "../query/order.ts"
import type { FilterNode, OrderTerm } from "../query-types.ts"
import type { Axes } from "./axes.ts"
import type { ListingRequest } from "./types.ts"

/** The order a listing's rows take, and what that order changes about which rows there are. */
export interface ListingOrder {
	/** The order with its tiebreaks: a total order, unless the sort is unstable. */
	fullOrder: OrderTerm[]
	/** Under SORT_DESC_DROPS_NULLS: a not-null test per descending key. */
	dropNulls: FilterNode[]
	/** Ties come back in an arbitrary order: UNSTABLE_SORT. */
	unstable: boolean
}

/** The listing's order. Throws `SqlError` for an order a correct backend refuses. */
export function listingOrder(request: ListingRequest, ctx: ParseContext, axes: Axes): ListingOrder {
	const { defects, entity } = ctx
	const order = chosenOrder(request, ctx, axes)
	const dropNulls: FilterNode[] = defects.has("SORT_DESC_DROPS_NULLS")
		? order.filter((term) => term.descending).map((term) => ({ field: term.field, kind: "isnull", negate: true }))
		: []
	/* A sort without a total order is not a sort: equal keys may come back in any order, and
	 * paging over it silently loses rows. The identity tiebreak is what makes paging sound. */
	const unstable = defects.has("UNSTABLE_SORT")
	return { dropNulls, fullOrder: unstable ? order : withTiebreaks(order, entity, defects), unstable }
}

/* The order asked for, or the documented default where none is asked for or the asked one is dropped. */
function chosenOrder(request: ListingRequest, ctx: ParseContext, axes: Axes): OrderTerm[] {
	const { defects, entity } = ctx
	/* Without an order the documented default applies — unless the backend forgets it. */
	const named = request.order === undefined || request.order === "" ? undefined : request.order
	const fallback = defects.has("DEFAULT_ORDER_IGNORED") ? undefined : entity.defaultOrder
	const implicit: OrderTerm[] = parseOrder(fallback ?? "", ctx, true)
	const requested: OrderTerm[] = named === undefined ? implicit : parseOrder(named, ctx)
	const orderDropped = defects.has("ORDER_DROPPED_WHEN_SELECTED") && axes.selected && named !== undefined
	return defects.has("ORDER_IGNORED") || orderDropped ? implicit : requested
}

function withTiebreaks(order: OrderTerm[], entity: EntityDef, defects: DefectSet): OrderTerm[] {
	/* Ties broken by a text field instead of the declared tiebreak: still a total order, so pages
	 * are sound, but not the one the document promises. */
	const tiebreak = defects.has("TIEBREAK_NOT_APPLIED")
		? entity.fields.find((field) => field.searchable === true && field.name !== entity.identity)?.name
		: undefined
	return [
		...order,
		...(tiebreak === undefined ? [] : [{ asText: true, descending: false, field: tiebreak, nullsFirst: false }]),
		{ asText: false, descending: false, field: entity.identity, nullsFirst: false },
	]
}
