/**
 * Field names a `*From` source read off a live response, added to one axis of the capabilities.
 * A harvested type is mapped through the source's `typeMap`, or kept when it is already a type.
 */

import type { FieldType, FilterableFrom } from "../../config/types/query.ts"
import type { EffectiveFilterField, EffectiveQueryCapabilities, EffectiveSortableField } from "./effective.ts"
import { isFieldType } from "./ops.ts"
import { unionNamed, unionStrings } from "./union.ts"

export type HarvestAxis = "filterable" | "sortable" | "searchable" | "selectable"

function mapHarvestType(from: FilterableFrom | undefined, rawType: string | undefined): FieldType | undefined {
	if (rawType === undefined) return undefined
	return from?.typeMap?.[rawType] ?? (isFieldType(rawType) ? rawType : undefined)
}

function typedRow(field: string, type: FieldType | undefined): { field: string; type?: FieldType } {
	return type === undefined ? { field } : { field, type }
}

export function applyHarvest(
	caps: EffectiveQueryCapabilities,
	names: string[],
	types: Array<string | undefined> = [],
	axis: HarvestAxis = "filterable",
): EffectiveQueryCapabilities {
	const extraNames = names.filter((name) => name !== "")
	if (axis === "searchable") return { ...caps, searchable: unionStrings(caps.searchable, extraNames) }
	if (axis === "selectable") return { ...caps, selectable: unionStrings(caps.selectable, extraNames) }
	if (axis === "sortable") {
		/* A sortable row takes the type at its name's first place among the names. */
		const extra: EffectiveSortableField[] = extraNames.map((field) =>
			typedRow(field, mapHarvestType(caps.sortableFrom, types[extraNames.indexOf(field)])),
		)
		return { ...caps, sortable: unionNamed(caps.sortable, extra) }
	}
	const extra: EffectiveFilterField[] = extraNames.map((name, index) =>
		typedRow(name, mapHarvestType(caps.filterableFrom, types[index])),
	)
	return { ...caps, filterable: unionNamed(caps.filterable, extra) }
}
