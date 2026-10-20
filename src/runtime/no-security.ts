/*
 * An anonymous probe expects a refusal, and only a declared requirement says one is due. A document
 * that declares no security at all says nothing either way, so the probe stands down untested.
 */

import type { OperationModel } from "../spec/graph/types.ts"

/** Why an anonymous probe of `op` cannot be judged, or `undefined` when its security is declared. */
export function noSecurityReason(op: OperationModel): string | undefined {
	return op.security.source === "none" ? "the document declares no security; add an overlay" : undefined
}
