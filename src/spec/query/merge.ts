/**
 * One list endpoint's effective capabilities: the `x-query` tag, the global config and the
 * entity's config merged per axis. A declared axis is never widened by a guess; an axis nobody
 * declared falls back to the heuristic reading of the tag.
 */

import type { FieldType, FilterableField, SortableField } from "../../config/types/query.ts"
import { assignOptional, overlayCatalog } from "./catalog-layers.ts"
import type {
	EffectiveFilterField,
	EffectiveQueryCapabilities,
	EffectiveSortableField,
	MergeInput,
	MergeTag,
} from "./effective.ts"
import { inferTypesFromSchema } from "./infer-type.ts"
import { unionNamed, unionStrings } from "./union.ts"

export function emptyCapabilities(): EffectiveQueryCapabilities {
	return {
		aliases: {},
		filterable: [],
		hook: false,
		searchable: [],
		selectable: [],
		sortable: [],
		source: "heuristic",
	}
}

interface Axis<T> {
	tagDeclared: boolean
	tagValues: T[]
	configDeclared: boolean
	config: T[]
	heuristic: T[]
}

/** The tag's values when it declared the axis, unioned with config's when config did; else the guess. */
function resolveAxis<T>(input: Axis<T>, union: (base: T[], extra: T[]) => T[]): T[] {
	if (!input.tagDeclared && !input.configDeclared) return input.heuristic
	const values = input.tagDeclared ? input.tagValues : []
	return input.configDeclared ? union(values, input.config) : values
}

const named = (names: string[]): Array<{ field: string }> => names.map((field) => ({ field }))

/** Whether the tag is a real `x-query` that declared `axis`. */
const tagDeclares = (
	tag: MergeTag | null,
	axis: `${"filterable" | "sortable" | "searchable" | "selectable"}Declared`,
) => tag?.source === "tag" && tag[axis] === true

function withInferredType(field: FilterableField, types: Map<string, FieldType>): EffectiveFilterField {
	const effective: EffectiveFilterField = { field: field.field }
	const type = field.type ?? types.get(field.field)
	if (type !== undefined) effective.type = type
	if (field.ops !== undefined) effective.ops = field.ops
	return effective
}

function withInferredSortType(field: SortableField, types: Map<string, FieldType>): EffectiveSortableField {
	const effective: EffectiveSortableField = { field: field.field }
	const type = field.type ?? types.get(field.field)
	if (type !== undefined) effective.type = type
	if (field.nulls !== undefined) effective.nulls = field.nulls
	return effective
}

function filterableAxis({ tag, global, entity }: MergeInput, types: Map<string, FieldType>): EffectiveFilterField[] {
	const fields = resolveAxis<FilterableField>(
		{
			config: [...(global?.filterable ?? []), ...(entity?.filterable ?? [])],
			configDeclared: global?.filterable !== undefined || entity?.filterable !== undefined,
			heuristic: named(tag?.filterable ?? []),
			tagDeclared: tagDeclares(tag, "filterableDeclared"),
			tagValues: tag?.filterFields ?? named(tag?.filterable ?? []),
		},
		unionNamed,
	)
	return fields.map((field) => withInferredType(field, types))
}

function sortableAxis({ tag, global, entity }: MergeInput, types: Map<string, FieldType>): EffectiveSortableField[] {
	const fields = resolveAxis<SortableField>(
		{
			config: [...(global?.sortable ?? []), ...(entity?.sortable ?? [])],
			configDeclared: global?.sortable !== undefined || entity?.sortable !== undefined,
			heuristic: named(tag?.sortable ?? []),
			tagDeclared: tagDeclares(tag, "sortableDeclared"),
			tagValues: tag?.sortableFields ?? named(tag?.sortable ?? []),
		},
		unionNamed,
	)
	return fields.map((field) => withInferredSortType(field, types))
}

/** The config's searchable names: an explicit `null` on the entity, or on a global the entity leaves alone, is none. */
function configSearchable(entity: string[] | null | undefined, global: string[] | null | undefined): string[] {
	if (entity === undefined) return global ?? []
	if (entity === null) return []
	return global === null || global === undefined ? entity : unionStrings(global, entity)
}

function searchableAxis({ tag, global, entity }: MergeInput): string[] {
	return resolveAxis(
		{
			config: configSearchable(entity?.searchable, global?.searchable),
			configDeclared: global?.searchable !== undefined || entity?.searchable !== undefined,
			heuristic: tag?.searchable ?? [],
			tagDeclared: tagDeclares(tag, "searchableDeclared"),
			tagValues: tag?.searchable ?? [],
		},
		unionStrings,
	)
}

function selectableAxis({ tag, global, entity }: MergeInput): string[] {
	return resolveAxis(
		{
			config:
				entity?.selectable === undefined
					? (global?.selectable ?? [])
					: unionStrings(global?.selectable ?? [], entity.selectable),
			configDeclared: global?.selectable !== undefined || entity?.selectable !== undefined,
			heuristic: tag?.selectable ?? [],
			tagDeclared: tagDeclares(tag, "selectableDeclared"),
			tagValues: tag?.selectable ?? [],
		},
		unionStrings,
	)
}

function sourceOf({ tag, global, entity }: MergeInput): EffectiveQueryCapabilities["source"] {
	const tagContributed = tag?.source === "tag"
	const configContributed = global !== undefined || entity !== undefined
	if (tagContributed) return configContributed ? "mixed" : "tag"
	return configContributed ? "config" : "heuristic"
}

export function mergeQueryCapabilities(input: MergeInput): EffectiveQueryCapabilities {
	const types = inferTypesFromSchema(input.itemSchema ?? null)
	const catalog = overlayCatalog(input.tag, input.global, input.entity)
	const result: EffectiveQueryCapabilities = {
		aliases: catalog.aliases ?? {},
		filterable: filterableAxis(input, types),
		hook: false,
		searchable: searchableAxis(input),
		selectable: selectableAxis(input),
		sortable: sortableAxis(input, types),
		source: sourceOf(input),
	}
	assignOptional(result, catalog)
	return result
}
