/**
 * Declared query capabilities — the catalog every list check consults.
 *
 * oat does not own which fields, operators, search modes, or nulls policies an API supports.
 * Those are declared on `x-query`, in `config.query` / `config.entities`, or harvested.
 * Missing capability → the check does not apply. New surface is never inferred.
 */

import type {
	FieldType,
	FilterableField,
	FilterableFrom,
	FilterOp,
	Nulls,
	QueryCapabilities,
	SearchMode,
	SortableField,
} from "../../config/types/query.ts"
import type { JsonSchema } from "../types.ts"

export interface EffectiveFilterField {
	field: string
	type?: FieldType
	ops?: FilterOp[]
}

export interface EffectiveSortableField {
	field: string
	type?: FieldType
	nulls?: Nulls[]
}

export interface EffectiveQueryCapabilities {
	filterable: EffectiveFilterField[]
	sortable: EffectiveSortableField[]
	searchable: string[]
	selectable: string[]
	operators?: FilterOp[]
	operatorsByType?: Partial<Record<FieldType, FilterOp[]>>
	aliases: Partial<Record<FilterOp, FilterOp>>
	identityFilter?: string
	emptyIn?: "reject" | "match-none"
	/** What a page size of 0 or past the maximum gets: refused, or served clamped. Undeclared, either. */
	limitOutOfRange?: "reject" | "clamp"
	maxInValues?: number
	maxFilterConditions?: number
	searchModes?: SearchMode[]
	searchEmpty?: "ignore" | "match-all" | "reject"
	searchCase?: "sensitive" | "insensitive"
	sort?: QueryCapabilities["sort"]
	select?: QueryCapabilities["select"]
	filterableFrom?: FilterableFrom
	sortableFrom?: FilterableFrom
	searchableFrom?: FilterableFrom
	selectableFrom?: FilterableFrom
	source: "tag" | "config" | "heuristic" | "mixed"
	hook: boolean
}

export interface MergeTag {
	filterable: string[]
	sortable: string[]
	searchable: string[]
	selectable: string[]
	source: "tag" | "heuristic"
	filterableDeclared?: boolean
	sortableDeclared?: boolean
	searchableDeclared?: boolean
	selectableDeclared?: boolean
	filterFields?: FilterableField[]
	sortableFields?: SortableField[]
	catalog?: QueryCapabilities
	defaultOrder?: string
	stableTiebreak?: string
}

export interface MergeInput {
	tag: MergeTag | null
	global?: QueryCapabilities
	entity?: QueryCapabilities
	itemSchema?: JsonSchema | null
}
