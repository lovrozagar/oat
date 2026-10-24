/* The plan a store answers a listing from: which rows, in what order. Types only, so stores and the
 * planner share them without importing each other. */

export type Scalar = string | number | boolean | null

export type LikeSegment = { kind: "text"; text: string } | { kind: "any" } | { kind: "one" }

export type ComparisonOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte"

export type FilterNode =
	| { kind: "const"; value: boolean }
	| { kind: "and" | "or"; children: FilterNode[] }
	| {
			kind: "cmp"
			field: string
			op: ComparisonOp
			value: Scalar
			/** Compare the textual form of both sides — the numeric-as-text defect. */
			asText: boolean
			/** Whether a null value satisfies the predicate. True only for a correct `neq`. */
			nullsMatch: boolean
	  }
	| { kind: "in"; field: string; values: Scalar[]; negate: boolean; asText: boolean }
	| { kind: "isnull"; field: string; negate: boolean }
	| { kind: "like"; field: string; pattern: LikeSegment[]; insensitive: boolean }
	/** Array membership. `substring` is the defect: the serialized array matched as text. */
	| { kind: "contains"; field: string; value: string; substring: boolean }
	| {
			kind: "search"
			fields: string[]
			token: string
			/** `prefix`: some field starts with the token; `contains`: some field contains it. */
			mode: SearchMode
			caseSensitive: boolean
	  }

export interface OrderTerm {
	field: string
	descending: boolean
	nullsFirst: boolean
	asText: boolean
}

export type Collation = "binary" | "insensitive"

export type SearchMode = "contains" | "prefix"

/** Everything a store needs to answer a listing: which rows, in what order. */
export interface SelectPlan {
	where: FilterNode
	order: OrderTerm[]
	/** Text ordering. Filters always compare binary; only ordering follows the collation. */
	collation: Collation
	/**
	 * Tied rows come back in an arbitrary, varying order — what a database does when the sort
	 * has no total order. Set only under UNSTABLE_SORT; otherwise the identity breaks every tie.
	 */
	shuffleTies: boolean
}
