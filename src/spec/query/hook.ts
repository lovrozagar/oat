/**
 * What a config's capabilities hook returned, laid over the merged capabilities: `null` keeps
 * them, a list replaces the filterable fields, an object replaces each axis or key it sets.
 */

import type { FilterableField, QueryCapabilities, SortableField } from "../../config/types/query.ts"
import { assignOptional } from "./catalog-layers.ts"
import type { EffectiveFilterField, EffectiveQueryCapabilities, EffectiveSortableField } from "./effective.ts"

function toEffectiveFilter(field: FilterableField): EffectiveFilterField {
	const row: EffectiveFilterField = { field: field.field }
	if (field.type !== undefined) row.type = field.type
	if (field.ops !== undefined) row.ops = field.ops
	return row
}

function toEffectiveSort(field: SortableField): EffectiveSortableField {
	const row: EffectiveSortableField = { field: field.field }
	if (field.type !== undefined) row.type = field.type
	if (field.nulls !== undefined) row.nulls = field.nulls
	return row
}

function axes(next: EffectiveQueryCapabilities, result: Partial<QueryCapabilities>): void {
	if (result.filterable !== undefined) next.filterable = result.filterable.map(toEffectiveFilter)
	if (result.sortable !== undefined) next.sortable = result.sortable.map(toEffectiveSort)
	if (result.searchable !== undefined) next.searchable = result.searchable === null ? [] : [...result.searchable]
	if (result.selectable !== undefined) next.selectable = [...result.selectable]
}

export function applyHook(
	caps: EffectiveQueryCapabilities,
	result: FilterableField[] | Partial<QueryCapabilities> | null,
): EffectiveQueryCapabilities {
	if (result === null) return { ...caps, hook: true }
	if (Array.isArray(result)) return { ...caps, filterable: result.map(toEffectiveFilter), hook: true }
	const next: EffectiveQueryCapabilities = { ...caps, hook: true }
	axes(next, result)
	assignOptional(next, result)
	if (result.aliases !== undefined) next.aliases = { ...caps.aliases, ...result.aliases }
	if (caps.source === "heuristic") next.source = "config"
	return next
}
