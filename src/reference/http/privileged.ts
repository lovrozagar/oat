/** Fields only admin may set: a lower rank's write that names one is refused, and a replacement keeps it. */

import type { EntityDef } from "../model/types.ts"
import type { Row } from "../store-api.ts"
import { HttpError } from "./errors.ts"
import type { EntityCall } from "./handlers/entity.ts"
import type { ReferenceState } from "./state.ts"

const ADMIN = 2

/** The entity's fields marked privileged. */
export function privilegedFields(entity: EntityDef): string[] {
	return entity.fields.filter((field) => field.privileged === true).map((field) => field.name)
}

/* Whether this caller's write is held to the privileged fields. */
const guarded = (state: ReferenceState, call: EntityCall): boolean =>
	call.principal.rank < ADMIN && !state.defects.has("PRIVILEGED_FIELD_WRITABLE")

/** Refuses a lower rank's body that names a privileged field. */
export function assertPrivileged(state: ReferenceState, call: EntityCall, body: Row): void {
	if (!guarded(state, call)) return
	const named = privilegedFields(call.entity).find((name) => name in body)
	if (named !== undefined) throw new HttpError(403, "forbidden", `only admin may set "${named}"`)
}

/** A lower rank's changes without the privileged fields a replacement's defaults would reset. */
export function keepPrivileged(state: ReferenceState, call: EntityCall, changes: Row): Row {
	if (!guarded(state, call)) return changes
	const kept = { ...changes }
	for (const name of privilegedFields(call.entity)) delete kept[name]
	return kept
}
