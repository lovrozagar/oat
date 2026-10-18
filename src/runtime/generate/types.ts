/** The shapes value generation works in: schemas, cohort variants, options, results and the walk. */

export type Schema = Record<string, unknown>

export type Variant =
	| "baseline"
	| "lexical-first"
	| "lexical-last"
	| "null-heavy"
	| "unicode"
	| "metacharacter"
	| "boundary"

export interface GenerateOptions {
	variant?: Variant
	/** Position in a cohort. Different indexes give different values wherever the schema allows. */
	index?: number
	rand?: () => number
	/** Recursive schemas a document refers to as `oat-defs#/$defs/<name>`. */
	defs?: Record<string, Schema>
	/** Per-run token mixed into values that must not collide with an earlier run's. */
	nonce?: string
	/** Property names, at the top level, whose values must be distinct across runs too. */
	distinct?: ReadonlySet<string>
	/** Optional properties to leave out. A cohort sends them; a probe built on top need not. */
	optional?: "all" | "none"
}

export type Generated = { ok: true; value: unknown } | { ok: false; reason: string; pointer: string }

export interface Context {
	variant: Variant
	index: number
	rand: () => number
	defs: Record<string, Schema>
	nonce: string | undefined
	distinct: ReadonlySet<string>
	optional: "all" | "none"
	refs: string[]
	depth: number
}

/** Where the walk stands: its context, the JSON pointer it is at, and whether the value must be distinct. */
export interface At {
	ctx: Context
	pointer: string
	distinct: boolean
}

/** The walk itself, handed to the parts that recurse so none of them imports it back. */
export type Walk = (raw: unknown, ctx: Context, pointer: string, distinct: boolean) => unknown
