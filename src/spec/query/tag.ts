/** The fields an `x-query` tag may hold, as `docs/tags.md` documents them. */

import type {
	DeclaredFilterGrammar,
	DeclaredSortGrammar,
	FilterableField,
	Nulls,
	QueryCapabilities,
	SortableField,
} from "../../config/types/query.ts"

/** A field list: a name per field, or a row that says more about it. */
type Axis<Row> = (string | Row)[]

type SortBlock = NonNullable<QueryCapabilities["sort"]>
type SelectBlock = NonNullable<QueryCapabilities["select"]>

/**
 * The catalog's own keys, with the field lists in their written form, plus the keys the tag adds:
 * the grammars, the list's caps and order, and the flat spellings of the `sort` and `select` blocks.
 */
export interface QueryTag extends Omit<QueryCapabilities, "filterable" | "sortable" | "searchable" | "selectable"> {
	filterable: Axis<FilterableField>
	sortable: Axis<SortableField>
	/** `null` is an explicit claim of none. */
	searchable: Axis<{ field: string }> | null
	selectable: Axis<{ field: string }>
	grammar: DeclaredFilterGrammar
	sortGrammar: DeclaredSortGrammar
	maxLimit: number
	defaultOrder: string
	stableTiebreak: string
	sortNulls: Nulls[]
	maxSortKeys: number
	sortCollation: SortBlock["collation"]
	sortDefaultNulls: Nulls
	selectNested: boolean
	selectUnknown: SelectBlock["unknown"]
}
