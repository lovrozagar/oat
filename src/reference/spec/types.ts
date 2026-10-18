import type { EntityDef } from "../model.ts"
import type { ReferenceShape } from "../shapes.ts"

export type Json = Record<string, unknown>

/** What a document is generated from: the entities as this server serves them, and its shape. */
export interface SpecContext {
	entities: readonly EntityDef[]
	shape: ReferenceShape
}
