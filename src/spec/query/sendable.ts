/**
 * A list's query capabilities, cut to what a request can carry.
 *
 * A probe reaches the backend only through a query parameter: the one the operation declares for
 * the role, or, where filters are written one parameter per field, the field's own. A backend is
 * free to ignore a parameter it never declared, so a filter sent as `?id=…` to a list without an
 * `id` parameter, or an order to a list with no sort parameter at all, comes back as the unfiltered
 * or unsorted listing — and reads as a backend whose filtering or sorting is broken. What no
 * parameter can carry is withheld instead, and every check that needed it stands down naming the
 * parameter that is missing.
 *
 * A per-field filter the document's `x-query`, the config, a harvest or the hook states is kept:
 * that is an explicit claim the parameter exists. Only the guess made from the item schema is cut.
 */

import { filterSpec } from "../conventions/filter.ts"
import type { QueryConventions } from "../conventions/types.ts"
import type { QueryCapability } from "../extensions/query-tag.ts"
import type {
	EffectiveFilterField,
	EffectiveQueryCapabilities,
	EffectiveSortableField,
	MergeInput,
} from "./effective.ts"

/** One capability no parameter of the list can carry. */
export type Withheld =
	| { axis: "filterable"; row: EffectiveFilterField }
	| { axis: "sortable"; row: EffectiveSortableField }
	| { axis: "searchable" | "selectable"; row: string }

export interface Sendable {
	capabilities: EffectiveQueryCapabilities
	withheld: Withheld[]
}

/** What of the list operation decides what a request can carry. */
export interface SendableList {
	conventions: QueryConventions
	/** The query parameters the operation declares. */
	queryParamNames: readonly string[]
}

/**
 * `caps` with every row withheld that no declared parameter carries. `filterGuessed` says the
 * filter fields are the heuristic's guess (see `filterIsGuess`), and only then are per-field filters
 * held to the declared parameters.
 */
export function sendableCapabilities(
	caps: EffectiveQueryCapabilities,
	list: SendableList,
	filterGuessed: boolean,
): Sendable {
	const c = list.conventions
	const declared = new Set(list.queryParamNames)
	const perField = filterGuessed && filterSpec(c).param === "field"
	const withheld: Withheld[] = []
	const filterable = caps.filterable.filter((row) => {
		const kept = !perField || declared.has(row.field)
		if (!kept) withheld.push({ axis: "filterable", row })
		return kept
	})
	if (c.order === undefined) for (const row of caps.sortable) withheld.push({ axis: "sortable", row })
	const strings = (axis: "searchable" | "selectable", carried: boolean): string[] => {
		if (carried) return caps[axis]
		for (const row of caps[axis]) withheld.push({ axis, row })
		return []
	}
	return {
		capabilities: {
			...caps,
			filterable,
			searchable: strings("searchable", c.search !== undefined),
			selectable: strings("selectable", c.select !== undefined),
			sortable: c.order === undefined ? [] : caps.sortable,
		},
		withheld,
	}
}

/**
 * Whether the filter fields are the heuristic's guess from the item schema: the list has no
 * `x-query`, the config states no filterable fields, and neither a harvest nor the hook supplied any.
 */
export function filterIsGuess(
	input: { tag: { source: string } | null } & Pick<MergeInput, "global" | "entity">,
	caps: EffectiveQueryCapabilities,
): boolean {
	return (
		input.tag?.source === "heuristic" &&
		input.global?.filterable === undefined &&
		input.entity?.filterable === undefined &&
		caps.filterableFrom === undefined &&
		!caps.hook
	)
}

/** `caps` with `withheld` put back: what a check would have had, had the parameters existed. */
export function restoreWithheld(
	caps: EffectiveQueryCapabilities,
	withheld: readonly Withheld[],
): EffectiveQueryCapabilities {
	const next = { ...caps }
	for (const item of withheld) {
		if (item.axis === "filterable") next.filterable = [...next.filterable, item.row]
		else if (item.axis === "sortable") next.sortable = [...next.sortable, item.row]
		else next[item.axis] = [...next[item.axis], item.row]
	}
	return next
}

/* How many missing filter parameters a reason names before it counts the rest. */
const NAMED = 3

const MISSING = "which the list operation does not declare"

/** What `withheld` needed, as a check's needs: the parameter each axis is missing. */
export function describeWithheld(withheld: readonly Withheld[]): string {
	const axes = new Set(withheld.map((item) => item.axis))
	const reasons: string[] = []
	const fields = [...new Set(withheld.flatMap((item) => (item.axis === "filterable" ? [item.row.field] : [])))]
	if (fields.length > 0) {
		const named = fields
			.slice(0, NAMED)
			.map((field) => `\`${field}\``)
			.join(", ")
		const more = fields.length > NAMED ? ` and ${fields.length - NAMED} more` : ""
		reasons.push(`the ${named} query parameter${fields.length === 1 ? "" : "s"}${more}, ${MISSING}`)
	}
	if (axes.has("sortable")) reasons.push(`a sort parameter, ${MISSING}`)
	if (axes.has("searchable")) reasons.push(`a free-text search parameter, ${MISSING}`)
	if (axes.has("selectable")) reasons.push(`a sparse-fieldset parameter, ${MISSING}`)
	return reasons.join("; ")
}

/** The list's query with each axis read off `caps`; `null` for a list with no query. */
export function queryOver(tag: QueryCapability | null, caps: EffectiveQueryCapabilities): QueryCapability | null {
	return tag === null
		? null
		: {
				...tag,
				filterable: caps.filterable.map((field) => field.field),
				searchable: caps.searchable,
				selectable: caps.selectable,
				sortable: caps.sortable.map((field) => field.field),
			}
}
