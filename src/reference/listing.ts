/**
 * A collection read, end to end, above any store.
 *
 * The store answers one question — which rows match, in what order — and everything a listing
 * adds on top is decided here once: validating the paging parameters, resolving a cursor, cutting
 * the window, counting, projecting a sparse fieldset. Every defect that corrupts one of those
 * steps is applied here too, so a broken count or an off-by-one page is the same bug on every
 * engine rather than three bugs that happen to share a name.
 */

import type { DefectSet } from "./defects.ts"
import type { EntityDef } from "./model.ts"
import { OVERCLAIMED_FIELD } from "./model.ts"
import {
	type Collation,
	type FilterNode,
	type OrderTerm,
	type QueryConventions,
	and,
	fieldsIn,
	parseFilter,
	parseOrder,
	parseSearch,
	SEARCH_MODES,
	type SearchMode,
} from "./query.ts"
import { type Row, SqlError, type Store, decodeCursor, encodeCursor } from "./store-api.ts"

/** A listing request with every parameter already rewritten into the canonical grammar. */
export interface ListingRequest {
	filter?: string | undefined
	order?: string | undefined
	select?: string | undefined
	q?: string | undefined
	searchMode?: string | undefined
	limit?: string | undefined
	page?: string | undefined
	offset?: string | undefined
	cursor?: string | undefined
}

export interface ListingOptions {
	/** Parent constraints from the path: `{ project_id, table_id }`. */
	scope: Record<string, string | number>
	conventions: QueryConventions
	/**
	 * A ceiling the server applies without documenting it. A request above it is served a short
	 * page rather than rejected — the "clamps silently" behaviour many real APIs have.
	 */
	clampLimit?: number | undefined
	/** Applied to each row before projection; the listing-only skew and job progress hook in here. */
	transform?: ((row: Row) => Row) | undefined
	/** Loads the record a relation names for `row`, for a nested select such as `table(name)`. */
	embed?: ((relation: string, row: Row) => Promise<Row | null>) | undefined
}

export interface ListingResult {
	items: Row[]
	count: number
	hasMore: boolean
	nextCursor: string | null
	page: number | null
	offset: number
	limit: number
}

function integerParam(raw: string | undefined, name: string, min: number, max?: number): number | undefined {
	if (raw === undefined) return undefined
	const value = Number(raw)
	if (raw.trim() === "" || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
		const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`
		throw new SqlError("invalid_paging", `query parameter "${name}" must be an integer ${range}`)
	}
	return value
}

function invert(collation: Collation): Collation {
	return collation === "binary" ? "insensitive" : "binary"
}

/**
 * Which axes a request combines. Each FILTER_DROPPED_WHEN_* defect keeps the filter while it is
 * alone and drops it once its named combination is present — the combination is the bug.
 */
interface Axes {
	sorted: boolean
	selected: boolean
	searched: boolean
}

function axesOf(request: ListingRequest): Axes {
	return {
		searched: request.q !== undefined && request.q.trim() !== "",
		selected: request.select !== undefined && request.select !== "" && request.select !== "*",
		sorted: request.order !== undefined && request.order !== "",
	}
}

function filterDropped(defects: DefectSet, { sorted, selected, searched }: Axes): boolean {
	return (
		(defects.has("FILTER_DROPPED_WHEN_SORTED_SEARCHED_AND_SELECTED") && sorted && searched && selected) ||
		(defects.has("FILTER_DROPPED_WHEN_SORTED") && sorted) ||
		(defects.has("FILTER_DROPPED_WHEN_SELECTED") && selected) ||
		(defects.has("FILTER_DROPPED_WHEN_SEARCHED") && searched) ||
		(defects.has("FILTER_DROPPED_WHEN_SORTED_AND_SELECTED") && sorted && selected) ||
		(defects.has("FILTER_DROPPED_WHEN_SORTED_AND_SEARCHED") && sorted && searched) ||
		(defects.has("FILTER_DROPPED_WHEN_SEARCHED_AND_SELECTED") && searched && selected)
	)
}

/** `relation(field,field)` inside a sparse fieldset. */
const NESTED = /^([A-Za-z_][\w]*)\(([^()]*)\)$/

/** Splits a sparse fieldset on top-level commas, so `id,table(name,status)` is two entries. */
function selectEntries(select: string): string[] {
	const out: string[] = []
	let depth = 0
	let current = ""
	for (const ch of select) {
		if (ch === "(") depth++
		if (ch === ")") depth--
		if (ch === "," && depth === 0) {
			out.push(current.trim())
			current = ""
		} else current += ch
	}
	out.push(current.trim())
	return out.filter(Boolean)
}

/** Validates a sparse fieldset against the entity before any row is read. */
function checkSelect(select: string | undefined, entity: EntityDef, defects: DefectSet): void {
	if (select === undefined || select === "" || select === "*") return
	for (const entry of selectEntries(select)) {
		const nested = NESTED.exec(entry)
		if (nested !== null) {
			const relation = entity.relations?.[nested[1] ?? ""]
			const fields = (nested[2] ?? "").split(",").map((field) => field.trim())
			if (relation === undefined || fields.some((field) => !relation.fields.includes(field))) {
				throw new SqlError("invalid_select", `"${entry}" is not a selectable relation`)
			}
			continue
		}
		if (defects.has("SPEC_OVERCLAIMS_SELECTABLE") && entry === OVERCLAIMED_FIELD) {
			throw new SqlError("invalid_select", `field "${OVERCLAIMED_FIELD}" is not selectable`)
		}
		const known = entity.fields.some((field) => field.name === entry)
		if (!known && entity.filterCatalog?.selectUnknown === "reject" && !defects.has("SELECT_UNKNOWN_IGNORED")) {
			throw new SqlError("invalid_select", `field "${entry}" is not selectable`)
		}
	}
}

export async function project(
	row: Row,
	select: string | undefined,
	entity: EntityDef,
	defects: DefectSet,
	embed?: ListingOptions["embed"],
): Promise<Row> {
	if (select === undefined || select === "" || select === "*") return { ...row }
	if (defects.has("SELECT_IGNORED")) return { ...row }
	const out: Row = {}
	for (const entry of selectEntries(select)) {
		const nested = NESTED.exec(entry)
		if (nested !== null) {
			const name = nested[1] ?? ""
			const related = embed === undefined ? null : await embed(name, row)
			if (related === null) {
				out[name] = null
				continue
			}
			/* The defect embeds the whole related record instead of the fields asked for. */
			if (defects.has("NESTED_SELECT_IGNORED")) {
				out[name] = related
				continue
			}
			const fields = (nested[2] ?? "").split(",").map((field) => field.trim())
			out[name] = Object.fromEntries(
				fields.filter((field) => Object.hasOwn(related, field)).map((f) => [f, related[f]]),
			)
			continue
		}
		if (!Object.hasOwn(row, entry)) continue
		if (defects.has("SELECT_FIELD_MISSING") && entry !== entity.identity) continue
		out[entry] = row[entry]
	}
	return out
}

export async function runListing(
	store: Store,
	entity: EntityDef,
	request: ListingRequest,
	options: ListingOptions,
	defects: DefectSet,
): Promise<ListingResult> {
	const ctx = { conventions: options.conventions, defects, entity }

	/* -- paging parameters, validated against the ranges the document publishes -- */
	const ceiling = defects.has("LIMIT_EXCEEDS_MAX") || options.clampLimit !== undefined ? undefined : entity.maxLimit
	const requestedLimit = integerParam(request.limit, "limit", 1, ceiling) ?? entity.defaultLimit
	const servedLimit = defects.has("LIMIT_EXCEEDS_MAX")
		? requestedLimit
		: Math.min(requestedLimit, options.clampLimit ?? entity.maxLimit)
	const page = integerParam(request.page, "page", 1)
	const offsetParam = integerParam(request.offset, "offset", 0)

	/* -- the predicate -- */
	const scope: FilterNode[] = Object.entries(options.scope)
		.filter(([name]) => entity.fields.some((field) => field.name === name))
		.map(([field, value]) => ({ asText: false, field, kind: "cmp", nullsMatch: false, op: "eq", value }))
	const axes = axesOf(request)
	checkSelect(request.select, entity, defects)
	const filter =
		request.filter === undefined || request.filter === "" || filterDropped(defects, axes)
			? null
			: parseFilter(request.filter, ctx)
	const mode = request.searchMode ?? "contains"
	if (!(SEARCH_MODES as readonly string[]).includes(mode)) {
		throw new SqlError("invalid_search", `search mode "${mode}" is not one of ${SEARCH_MODES.join(", ")}`)
	}
	if (mode === "prefix" && defects.has("SEARCH_MODE_REJECTED")) {
		throw new SqlError("invalid_search", 'search mode "prefix" is not supported')
	}
	/* Each of these keeps the search while it is alone and drops it once its axis joins. */
	const searchDropped =
		(defects.has("SEARCH_DROPPED_WHEN_SELECTED") && axes.selected) ||
		(defects.has("SEARCH_DROPPED_WHEN_SORTED") && axes.sorted)
	const search =
		request.q === undefined || defects.has("SEARCH_IGNORED") || searchDropped
			? null
			: parseSearch(request.q, entity, defects, mode as SearchMode)
	const soft = entity.softDeleteField
	/* Tombstones are hidden unless the caller asked about them by name. */
	const tombstones: FilterNode | null =
		soft === undefined || defects.has("SOFT_DELETE_LEAK") || (filter !== null && fieldsIn(filter).includes(soft))
			? null
			: { field: soft, kind: "isnull", negate: false }
	/* The tenant predicate is applied to the plain listing but dropped once a filter is present,
	 * which is how a filter turns into an authorization bypass. */
	const scoped = defects.has("TENANT_LEAK_VIA_FILTER") && filter !== null ? [] : scope

	/* -- the order -- */
	/* Without an order the documented default applies — unless the backend forgets it. */
	const named = request.order === undefined || request.order === "" ? undefined : request.order
	const fallback = defects.has("DEFAULT_ORDER_IGNORED") ? undefined : entity.defaultOrder
	const implicit: OrderTerm[] = parseOrder(fallback ?? "", ctx, true)
	const requested: OrderTerm[] = named === undefined ? implicit : parseOrder(named, ctx)
	const orderDropped = defects.has("ORDER_DROPPED_WHEN_SELECTED") && axes.selected && named !== undefined
	const order = defects.has("ORDER_IGNORED") || orderDropped ? implicit : requested
	const dropNulls: FilterNode[] = defects.has("SORT_DESC_DROPS_NULLS")
		? order.filter((term) => term.descending).map((term) => ({ field: term.field, kind: "isnull", negate: true }))
		: []
	/* A sort without a total order is not a sort: equal keys may come back in any order, and
	 * paging over it silently loses rows. The identity tiebreak is what makes paging sound. */
	const unstable = defects.has("UNSTABLE_SORT")
	const fullOrder = unstable
		? order
		: [...order, { asText: false, descending: false, field: entity.identity, nullsFirst: false }]

	/* Paging before filtering: the window is cut from the unfiltered set and the predicate is then
	 * applied to whatever that window held. */
	const pageBeforeFilter = defects.has("FILTER_AFTER_PAGINATION") && filter !== null
	const plan = (where: FilterNode, collation = options.conventions.collation) => ({
		collation,
		order: fullOrder,
		shuffleTies: unstable,
		where,
	})
	const listingWhere = and(...scoped, tombstones, pageBeforeFilter ? null : filter, search, ...dropNulls)
	let rows = await store.select(entity, plan(listingWhere))
	/* The "no results must mean the query was wrong" guard: an empty filtered set falls back to
	 * the unfiltered listing, which makes an empty result impossible to express. */
	if (defects.has("EMPTY_RESULT_RETURNS_ALL") && rows.length === 0 && (filter !== null || search !== null)) {
		rows = await store.select(entity, plan(and(...scope, tombstones)))
	}
	const count = defects.has("COUNT_ALWAYS_ZERO")
		? 0
		: defects.has("COUNT_IGNORES_FILTER")
			? (await store.select(entity, plan(and(...scope, tombstones)))).length
			: rows.length

	/* -- the window -- */
	let offset: number
	let pageNumber: number | null = null
	if (request.cursor !== undefined && request.cursor !== "") {
		const afterId = decodeCursor(request.cursor)
		/* The boundary must be resolved under exactly the listing's ordering. Under the defect it
		 * is resolved under the other collation, and that position is then used as an offset into
		 * the listing — a boundary the listing never had, so rows are skipped or repeated. */
		const ordered = defects.has("COLLATION_INCONSISTENT")
			? await store.select(entity, plan(listingWhere, invert(options.conventions.collation)))
			: rows
		const index = ordered.findIndex((row) => String(row[entity.identity]) === afterId)
		if (index === -1) throw new SqlError("invalid_cursor", "cursor does not point into this collection")
		offset = index + (defects.has("CURSOR_DRIFT") ? 0 : 1)
	} else if (offsetParam !== undefined) {
		offset = offsetParam + (defects.has("OFF_BY_ONE_PAGE") && offsetParam > 0 ? 1 : 0)
	} else {
		pageNumber = page ?? 1
		offset = (pageNumber - 1) * servedLimit + (defects.has("OFF_BY_ONE_PAGE") && pageNumber > 1 ? 1 : 0)
	}

	let window = defects.has("LIMIT_IGNORED") ? rows.slice(offset) : rows.slice(offset, offset + servedLimit)
	if (pageBeforeFilter && filter !== null) {
		const matching = await store.select(entity, plan(and(...scoped, tombstones, filter, search)))
		const allowed = new Set(matching.map((row) => String(row[entity.identity])))
		const filtered = window.filter((row) => allowed.has(String(row[entity.identity])))
		/* The empty-result guard looks at what is about to be returned, wherever the filter ran. */
		window = defects.has("EMPTY_RESULT_RETURNS_ALL") && filtered.length === 0 ? window : filtered
	}
	const hasMore = defects.has("HASMORE_ALWAYS_FALSE") ? false : offset + window.length < rows.length
	const last = window.at(-1)

	const items = await Promise.all(
		window
			.map((row) => (options.transform === undefined ? row : options.transform(row)))
			.map((row) => project(row, request.select, entity, defects, options.embed)),
	)

	return {
		count,
		hasMore,
		items,
		limit: servedLimit,
		nextCursor: hasMore && last !== undefined ? encodeCursor(String(last[entity.identity])) : null,
		offset,
		page: pageNumber,
	}
}
