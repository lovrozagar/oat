/** Which property identifies an operation's records, and how sure oat is of it. */

import { deriveIdentity } from "../collection/identity.ts"
import type { SchemaObject } from "../types.ts"
import type { OperationModel } from "./types.ts"

type Identity = Pick<OperationModel, "identity" | "identitySource">

/**
 * The identity `x-entity` declares, else the one the item route's parameter or the schema names.
 * `pathParams` are the operation's path parameters in order; the last one names an item route
 * when the path ends with it.
 */
/** An operation's path, and its path parameters in order. */
export interface OperationRoute {
	path: string
	pathParams: readonly string[]
}

export function operationIdentity(
	declared: string | undefined,
	itemSchema: SchemaObject | null,
	{ path, pathParams }: OperationRoute,
): Identity {
	const lastParam = pathParams.at(-1)
	const itemRoute = lastParam !== undefined && path.endsWith(`{${lastParam}}`)
	const identity = declared ?? deriveIdentity(itemSchema, lastParam, itemRoute)
	const identitySource: OperationModel["identitySource"] =
		declared !== undefined ? "declared" : identity === null ? null : itemRoute ? "route" : "schema"
	return { identity, identitySource }
}

/** How much an operation's identity counts when an entity's operations disagree. */
export function identityRank(source: OperationModel["identitySource"]): number {
	return source === "declared" ? 2 : source === "route" ? 1 : 0
}
