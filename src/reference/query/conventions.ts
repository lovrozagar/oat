import type { DefectSet } from "../defects/defect-set.ts"
import type { EntityDef } from "../model/types.ts"
import type { Collation, SearchMode } from "../query-types.ts"

export const SEARCH_MODES = ["contains", "prefix"] as const satisfies readonly SearchMode[]

/** Behaviour of a correct backend that varies between real APIs — see `ReferenceShape`. */
export interface QueryConventions {
	/** Where nulls sort when the request does not say. */
	nulls: "first" | "last"
	collation: Collation
	/** Reject a filter value that does not parse as the field's type, instead of matching nothing. */
	strictTypes: boolean
}

export const DEFAULT_CONVENTIONS: QueryConventions = { collation: "binary", nulls: "first", strictTypes: false }

/** What every parse reads: the entity, the defects the backend carries, and its conventions. */
export interface ParseContext {
	entity: EntityDef
	defects: DefectSet
	conventions: QueryConventions
}
