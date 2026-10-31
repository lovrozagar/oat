/*
 * What a list endpoint can be asked: the filter, sort, search and select capabilities an API
 * declares on `x-query` or a config states for it. Declared, never inferred: a capability nobody
 * declared is a check that does not apply.
 */

export type FilterOp =
	| "eq"
	| "ne"
	| "neq"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "in"
	| "nin"
	| "like"
	| "ilike"
	| "is"
	| "contains"
export type FieldType = "string" | "number" | "boolean" | "date" | "enum" | "array"
export type SearchMode = string
export type Nulls = "first" | "last"

export interface FilterableField {
	field: string
	type?: FieldType
	ops?: FilterOp[]
}

export interface SortableField {
	field: string
	type?: FieldType
	nulls?: Nulls[]
}

export interface SelectRelation {
	name: string
	fields: string[]
}

export interface FilterableFrom {
	operationId?: string
	route?: string
	path: string
	typePath?: string
	typeMap?: Record<string, FieldType>
}

export interface QueryCapabilities {
	filterable?: FilterableField[]
	sortable?: SortableField[]
	/** `null` is an explicit claim of none. */
	searchable?: string[] | null
	selectable?: string[]
	operators?: FilterOp[]
	operatorsByType?: Partial<Record<FieldType, FilterOp[]>>
	aliases?: Partial<Record<FilterOp, FilterOp>>
	identityFilter?: string
	emptyIn?: "reject" | "match-none"
	/** What a page size of 0 or past the maximum gets: refused, or served clamped. Undeclared, either. */
	limitOutOfRange?: "reject" | "clamp"
	maxInValues?: number
	maxFilterConditions?: number
	searchModes?: SearchMode[]
	searchEmpty?: "ignore" | "match-all" | "reject"
	searchCase?: "sensitive" | "insensitive"
	sort?: {
		defaultOrder?: string
		stableTiebreak?: string
		nulls?: Nulls[]
		maxKeys?: number
		/** How text compares in an order. Undeclared, oat accepts any consistent one. */
		collation?: "binary" | "case-insensitive" | "locale"
		/** Where nulls go in an ascending order with no modifier. Undeclared, either end, consistently. */
		defaultNulls?: Nulls
	}
	select?: {
		nested?: boolean
		unknown?: "reject" | "ignore"
		relations?: SelectRelation[]
	}
	filterableFrom?: FilterableFrom
	sortableFrom?: FilterableFrom
	searchableFrom?: FilterableFrom
	selectableFrom?: FilterableFrom
}

/** A filter grammar by preset name, or a template object the renderer validates. */
export type DeclaredFilterGrammar = "postgrest" | "colon" | "equality" | Record<string, unknown>
/** A sort grammar by preset name, or a template object the renderer validates. */
export type DeclaredSortGrammar = "dotted" | "prefixed" | "colon" | "spaced" | Record<string, unknown>

/** A query role, by the name the rest of the vocabulary uses: `sort` as in `sortable`, never `order`. */
export type QueryParamRole =
	| "filter"
	| "sort"
	| "select"
	| "search"
	| "searchMode"
	| "limit"
	| "page"
	| "offset"
	| "cursor"
/** The query parameter each role is sent in, for a role whose parameter no alias oat knows names. */
export type QueryParamNames = Partial<Record<QueryParamRole, string>>
