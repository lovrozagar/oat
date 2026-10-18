/**
 * Catalog layers stacked into one: the tag, then the global config, then the entity's. A later
 * layer replaces a key; the keyed tables (`operatorsByType`, `aliases`, `sort`, `select`) merge.
 */

import type { QueryCapabilities } from "../../config/types/query.ts"
import type { EffectiveQueryCapabilities, MergeTag } from "./effective.ts"

/** The catalog keys an effective capability map carries over as they are, in their order. */
const CARRIED = [
	"operators",
	"operatorsByType",
	"identityFilter",
	"emptyIn",
	"limitOutOfRange",
	"maxInValues",
	"maxFilterConditions",
	"searchModes",
	"searchEmpty",
	"searchCase",
	"sort",
	"select",
	"filterableFrom",
	"sortableFrom",
	"searchableFrom",
	"selectableFrom",
] as const satisfies ReadonlyArray<keyof QueryCapabilities & keyof EffectiveQueryCapabilities>

/** The keys a layer sets, in the order a stacked catalog lists them. */
const LAYERED = [
	"operators",
	"operatorsByType",
	"aliases",
	"identityFilter",
	"emptyIn",
	"limitOutOfRange",
	"maxInValues",
	"maxFilterConditions",
	"searchModes",
	"searchEmpty",
	"searchCase",
	"sort",
	"select",
	"filterableFrom",
	"sortableFrom",
	"searchableFrom",
	"selectableFrom",
] as const satisfies ReadonlyArray<keyof QueryCapabilities>

const MERGED: ReadonlySet<string> = /* @__PURE__ */ new Set(["operatorsByType", "aliases", "sort", "select"])

/** The tag's catalog with its flat `defaultOrder` / `stableTiebreak` lifted into `sort`, in place. */
function tagLayer(tag: MergeTag | null): QueryCapabilities {
	const fromTag = tag?.catalog ?? {}
	if (tag?.defaultOrder !== undefined || tag?.stableTiebreak !== undefined) {
		fromTag.sort = {
			...fromTag.sort,
			...(tag.defaultOrder === undefined ? {} : { defaultOrder: tag.defaultOrder }),
			...(tag.stableTiebreak === undefined ? {} : { stableTiebreak: tag.stableTiebreak }),
		}
	}
	return fromTag
}

function stack(out: Record<string, unknown>, layer: QueryCapabilities): void {
	for (const key of LAYERED) {
		const value = layer[key]
		if (value === undefined) continue
		out[key] = MERGED.has(key) ? { ...(out[key] as object | undefined), ...(value as object) } : value
	}
}

export function overlayCatalog(
	tag: MergeTag | null,
	global: QueryCapabilities | undefined,
	entity: QueryCapabilities | undefined,
): QueryCapabilities {
	const out: Record<string, unknown> = {}
	for (const layer of [tagLayer(tag), global, entity]) if (layer !== undefined) stack(out, layer)
	return out as QueryCapabilities
}

/** Copies every carried key `catalog` sets onto `target`. */
export function assignOptional(target: EffectiveQueryCapabilities, catalog: Partial<QueryCapabilities>): void {
	for (const key of CARRIED) {
		const value = catalog[key]
		if (value !== undefined) Object.assign(target, { [key]: value })
	}
}
