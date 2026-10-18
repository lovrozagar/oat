import type { DefectSet } from "../defects/defect-set.ts"
import type { EntityDef } from "../model/types.ts"
import type { ParseContext } from "../query/conventions.ts"
import { SEARCH_MODES } from "../query/conventions.ts"
import { parseFilter } from "../query/filter.ts"
import { parseSearch } from "../query/search.ts"
import { fieldsIn } from "../query/tree.ts"
import type { FilterNode, SearchMode } from "../query-types.ts"
import { SqlError } from "../store-api.ts"
import { type Axes, axesOf, filterDropped } from "./axes.ts"
import { checkSelect } from "./select.ts"
import type { ListingOptions, ListingRequest } from "./types.ts"

/** Which rows a listing holds, as the parts its queries combine. */
export interface ListingPredicate {
	axes: Axes
	/** The tenant and parent constraints from the path. */
	scope: FilterNode[]
	/** The scope as the listing applies it: a defect drops it once a filter is present. */
	scoped: FilterNode[]
	filter: FilterNode | null
	search: FilterNode | null
	/** Hides soft-deleted rows; `null` when nothing hides them. */
	tombstones: FilterNode | null
}

/**
 * The listing's predicate. Validates the select, then the filter, then the search, and throws
 * `SqlError` for the first a correct backend refuses.
 */
export function listingPredicate(
	request: ListingRequest,
	options: ListingOptions,
	ctx: ParseContext,
): ListingPredicate {
	const { defects, entity } = ctx
	const scope = scopeTerms(entity, options.scope)
	const axes = axesOf(request)
	checkSelect(request.select, entity, defects)
	const filter =
		request.filter === undefined || request.filter === "" || filterDropped(defects, axes)
			? null
			: parseFilter(request.filter, ctx)
	const search = searchOf(request, ctx, axes)
	const soft = entity.softDeleteField
	/* Tombstones are hidden unless the caller asked about them by name. */
	const tombstones: FilterNode | null =
		soft === undefined || defects.has("SOFT_DELETE_LEAK") || (filter !== null && fieldsIn(filter).includes(soft))
			? null
			: { field: soft, kind: "isnull", negate: false }
	/* The tenant predicate is applied to the plain listing but dropped once a filter is present,
	 * which is how a filter turns into an authorization bypass. */
	const scoped = defects.has("TENANT_LEAK_VIA_FILTER") && filter !== null ? [] : scope
	return { axes, filter, scope, scoped, search, tombstones }
}

/* An equality per path constraint the entity has a field for. */
function scopeTerms(entity: EntityDef, scope: ListingOptions["scope"]): FilterNode[] {
	return Object.entries(scope)
		.filter(([name]) => entity.fields.some((field) => field.name === name))
		.map(([field, value]) => ({ asText: false, field, kind: "cmp", nullsMatch: false, op: "eq", value }))
}

/* The free-text search, its mode validated first. */
function searchOf(request: ListingRequest, ctx: ParseContext, axes: Axes): FilterNode | null {
	const { defects, entity } = ctx
	const mode = request.searchMode ?? "contains"
	if (!(SEARCH_MODES as readonly string[]).includes(mode)) {
		throw new SqlError("invalid_search", `search mode "${mode}" is not one of ${SEARCH_MODES.join(", ")}`)
	}
	if (mode === "prefix" && defects.has("SEARCH_MODE_REJECTED")) {
		throw new SqlError("invalid_search", 'search mode "prefix" is not supported')
	}
	return request.q === undefined || defects.has("SEARCH_IGNORED") || searchDropped(defects, axes)
		? null
		: parseSearch(request.q, entity, defects, mode as SearchMode)
}

/* Each of these keeps the search while it is alone and drops it once its axis joins. */
function searchDropped(defects: DefectSet, axes: Axes): boolean {
	return (
		(defects.has("SEARCH_DROPPED_WHEN_SELECTED") && axes.selected) ||
		(defects.has("SEARCH_DROPPED_WHEN_SORTED") && axes.sorted)
	)
}
