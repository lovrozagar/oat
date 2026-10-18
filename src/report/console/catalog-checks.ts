import type { FilterOp } from "../../config/types/query.ts"
import { canWriteFilterOp, filterSpec, type QueryConventions } from "../../spec/conventions.ts"
import { canGroupAnd } from "../../spec/filter-render.ts"
import {
	anyFieldAllows,
	type EffectiveQueryCapabilities,
	fieldAllowsNulls,
	opsAreClosed,
} from "../../spec/query-capabilities.ts"

type Caps = EffectiveQueryCapabilities

/**
 * Operator checks: each applies when some field allows every operator it compares and the list's
 * grammar can write the operator it sends.
 */
const OPERATOR_CHECKS: ReadonlyArray<{ id: string; allows: FilterOp[]; writes: FilterOp[] }> = [
	{ allows: ["in"], id: "filter.in-is-union-of-eq", writes: ["in"] },
	{ allows: ["in", "nin"], id: "filter.nin-complements-in", writes: ["in", "nin"] },
	{ allows: ["gte", "gt"], id: "filter.gte-is-gt-or-eq", writes: ["gte"] },
	{ allows: ["lte", "lt"], id: "filter.lte-is-lt-or-eq", writes: ["lte"] },
	{ allows: ["lt", "gt"], id: "filter.ordered-triple-partitions", writes: ["lt"] },
	{ allows: ["ilike", "like"], id: "filter.ilike-is-case-insensitive", writes: ["ilike"] },
	{ allows: ["is"], id: "filter.is-null-selects-nulls", writes: ["is"] },
	{ allows: ["contains"], id: "filter.contains-membership", writes: ["contains"] },
]

function filterChecks(caps: Caps, conventions: QueryConventions, source: Caps["source"]): string[] {
	const spec = filterSpec(conventions)
	const allows = (op: FilterOp): boolean => anyFieldAllows(caps, op) !== undefined
	const write = (op: FilterOp): boolean => canWriteFilterOp(conventions, op)
	const ids = OPERATOR_CHECKS.filter((check) => check.allows.every(allows) && check.writes.every(write)).map(
		(check) => check.id,
	)
	if (spec.mixed && caps.filterable.length > 1) ids.push("filter.nested-and-or-distributes")
	if (Object.keys(caps.aliases).length > 0) ids.push("filter.alias-matches-canonical")
	if (caps.filterable.some((field) => opsAreClosed(field, caps))) {
		ids.push("filter.illegal-op-rejected")
		if (source === "tag" || source === "mixed") ids.push("spec.declared-filterable-ops-accepted")
	}
	const inWritable = allows("in") && write("in")
	if (caps.emptyIn !== undefined && inWritable) ids.push("filter.empty-in")
	if (caps.maxInValues !== undefined && inWritable) ids.push("filter.in-over-limit-rejected")
	if (caps.maxFilterConditions !== undefined && canGroupAnd(spec)) ids.push("filter.condition-cap-rejected")
	return ids
}

function sortChecks(caps: Caps, conventions: QueryConventions): string[] {
	if (conventions.order === undefined) return []
	const ids = ["sort.unknown-field-rejected"]
	if (caps.sortable.some((field) => field.type === "number")) ids.push("sort.numeric-order-is-numeric")
	if (caps.sortable.some((field) => fieldAllowsNulls(field, caps, "first") || fieldAllowsNulls(field, caps, "last"))) {
		ids.push("sort.nulls-first-last", "spec.declared-sortable-nulls-accepted")
	}
	if (caps.sortable.length >= 2 && (caps.sort?.maxKeys === undefined || caps.sort.maxKeys >= 2)) {
		ids.push("sort.multi-key-tiebreak")
	}
	if (caps.sort?.defaultOrder !== undefined) ids.push("sort.default-order-applied")
	if (caps.sort?.stableTiebreak !== undefined) ids.push("sort.stable-tiebreak")
	return ids
}

function searchSelectChecks(caps: Caps, conventions: QueryConventions): string[] {
	const ids: string[] = []
	if (conventions.search !== undefined && caps.searchable.length > 0) {
		ids.push("search.tokens-and", "search.case-insensitive")
		if (caps.searchEmpty !== undefined) ids.push("search.empty-q")
		if (caps.searchModes !== undefined && conventions.searchMode !== undefined) ids.push("search.mode-accepted")
	}
	if (conventions.select !== undefined && caps.selectable.length > 0) {
		ids.push("select.requested-fields-present")
		if (caps.select?.unknown !== undefined) ids.push("select.unknown-field-rejected")
		if (caps.select?.nested === true && (caps.select.relations?.length ?? 0) > 0) ids.push("select.nested-honoured")
	}
	return ids
}

/** Checks that compose two or more roles: each needs every role it combines usable. */
function composeChecks(caps: Caps, conventions: QueryConventions): string[] {
	const sort = conventions.order !== undefined && caps.sortable.length > 0
	const select = conventions.select !== undefined && caps.selectable.length > 0
	const search = conventions.search !== undefined && caps.searchable.length > 0
	const ids: string[] = []
	if (sort && select) ids.push("query.sort-and-select-compose")
	if (search && select) ids.push("query.search-and-select-compose")
	if (search && sort) ids.push("query.search-and-sort-compose")
	if (
		caps.filterable.length > 0 &&
		caps.searchable.length > 0 &&
		caps.sortable.length > 0 &&
		caps.selectable.length > 0
	) {
		ids.push("query.filter-search-sort-select-compose")
	}
	return ids
}

/** The declared-or-skip query checks a list's capabilities and grammar let run, in catalog order. */
export function catalogCheckPreview(
	caps: Caps,
	list: { conventions: QueryConventions },
	source: Caps["source"],
): string[] {
	return [
		...filterChecks(caps, list.conventions, source),
		...sortChecks(caps, list.conventions),
		...searchSelectChecks(caps, list.conventions),
		...composeChecks(caps, list.conventions),
	]
}
