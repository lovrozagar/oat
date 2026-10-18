import type { EntityDef } from "../model/types.ts"
import type { ReferenceShape } from "../shapes/types.ts"

export type Json = Record<string, unknown>

/** What a document is generated from: the entities as this server serves them, and its shape. */
export interface SpecContext {
	entities: readonly EntityDef[]
	shape: ReferenceShape
}
