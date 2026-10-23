/**
 * An `x-query` tag read into the structured catalog: every key it may hold, each validated, in
 * the order the catalog lists them. A key that does not validate is left out, never guessed.
 */

import type { FieldType, FilterOp, QueryCapabilities } from "../../config/types/query.ts"
import type { RawOf } from "../../config/types/raw.ts"
import { isFieldType, isFilterOp } from "./ops.ts"
import { parseFilterableFrom, parseSelectBlock, parseSortBlock } from "./parse-blocks.ts"
import { parseFilterable, parseSortable } from "./parse-fields.ts"
import type { QueryTag } from "./tag.ts"

type Tag = RawOf<QueryTag>

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)

const filterOps = (raw: unknown[]): FilterOp[] =>
	raw.filter((op): op is FilterOp => typeof op === "string" && isFilterOp(op))

const strings = (raw: unknown[]): string[] => raw.filter((v): v is string => typeof v === "string")

const positiveInt = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

function axes(tag: Tag): QueryCapabilities {
	const catalog: QueryCapabilities = {}
	const filterable = parseFilterable(tag.filterable)
	if (filterable.declared) catalog.filterable = filterable.fields
	const sortable = parseSortable(tag.sortable)
	if (sortable.declared) catalog.sortable = sortable.fields
	if (tag.searchable === null) catalog.searchable = null
	else if (Array.isArray(tag.searchable)) catalog.searchable = strings(tag.searchable)
	if (Array.isArray(tag.selectable)) catalog.selectable = strings(tag.selectable)
	return catalog
}

function operatorsByType(raw: Record<string, unknown>): Partial<Record<FieldType, FilterOp[]>> {
	const byType: Partial<Record<FieldType, FilterOp[]>> = {}
	for (const [key, ops] of Object.entries(raw)) {
		if (isFieldType(key) && Array.isArray(ops)) byType[key] = filterOps(ops)
	}
	return byType
}

function aliases(raw: Record<string, unknown>): Partial<Record<FilterOp, FilterOp>> {
	const out: Partial<Record<FilterOp, FilterOp>> = {}
	for (const [key, target] of Object.entries(raw)) {
		if (isFilterOp(key) && typeof target === "string" && isFilterOp(target)) out[key] = target
	}
	return out
}

function operators(tag: Tag): QueryCapabilities {
	const catalog: QueryCapabilities = {}
	if (Array.isArray(tag.operators)) catalog.operators = filterOps(tag.operators)
	if (isRecord(tag.operatorsByType)) catalog.operatorsByType = operatorsByType(tag.operatorsByType)
	if (isRecord(tag.aliases)) catalog.aliases = aliases(tag.aliases)
	if (typeof tag.identityFilter === "string" && tag.identityFilter !== "") catalog.identityFilter = tag.identityFilter
	if (tag.emptyIn === "reject" || tag.emptyIn === "match-none") catalog.emptyIn = tag.emptyIn
	if (tag.limitOutOfRange === "reject" || tag.limitOutOfRange === "clamp") catalog.limitOutOfRange = tag.limitOutOfRange
	const maxInValues = positiveInt(tag.maxInValues)
	if (maxInValues !== undefined) catalog.maxInValues = maxInValues
	const maxFilterConditions = positiveInt(tag.maxFilterConditions)
	if (maxFilterConditions !== undefined) catalog.maxFilterConditions = maxFilterConditions
	return catalog
}

function search(tag: Tag): QueryCapabilities {
	const catalog: QueryCapabilities = {}
	if (Array.isArray(tag.searchModes)) {
		catalog.searchModes = tag.searchModes.filter((v): v is string => typeof v === "string" && v !== "")
	}
	if (tag.searchEmpty === "ignore" || tag.searchEmpty === "match-all" || tag.searchEmpty === "reject") {
		catalog.searchEmpty = tag.searchEmpty
	}
	if (tag.searchCase === "sensitive" || tag.searchCase === "insensitive") catalog.searchCase = tag.searchCase
	return catalog
}

const SOURCES = ["filterableFrom", "sortableFrom", "searchableFrom", "selectableFrom"] as const

function blocks(tag: Tag): QueryCapabilities {
	const catalog: QueryCapabilities = {}
	const sort = parseSortBlock(tag)
	if (sort !== undefined) catalog.sort = sort
	const select = parseSelectBlock(tag)
	if (select !== undefined) catalog.select = select
	for (const key of SOURCES) {
		const from = parseFilterableFrom(tag[key])
		if (from !== undefined) catalog[key] = from
	}
	return catalog
}

export function parseQueryCatalog(tag: Tag): QueryCapabilities {
	return { ...axes(tag), ...operators(tag), ...search(tag), ...blocks(tag) }
}
