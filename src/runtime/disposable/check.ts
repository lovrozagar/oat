/**
 * `x-destructive` runs as a second user, never the suite caller. That user signs up through the
 * document's `x-fresh-principal` operation and is a principal of its own in the run's store.
 * Afterwards the suite caller's own read still answers 200. An operation that invalidates the
 * caller read must leave that second user's credential refused, and a declared refresh must no
 * longer renew it.
 *
 * What a destructive call needs beforehand — a second factor enabled, a credential registered,
 * ownership handed off — is product knowledge. When the call is refused for want of it, the
 * operation stays untested and a scenario sets the scene.
 */

import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { CheckId } from "../check-ids.ts"
import type { Check } from "../checks/core/check.ts"
import { ASSERTED, type Outcome } from "../finding.ts"

export const DISPOSABLE_CHECK_ID = "auth.destructive-spares-the-caller" as const satisfies CheckId

export const disposableCheck: Check = {
	id: DISPOSABLE_CHECK_ID,
	mutates: true,
	needs: "x-destructive, a way to sign up a second user, and a caller read",
	plan: () => ({ ok: false }),
	run: (): Promise<Outcome> => Promise.resolve(ASSERTED),
	/* Destructive routes have no entity. `runDisposableOps` grades them after the entity loop. */
	subjects: () => [],
}

export function destructiveOps(model: SpecModel): OperationModel[] {
	return model.operations.filter((op) => op.destructive && op.unsendable === null)
}

/** The caller reading itself: an `identity: self` read with nothing to fill in. */
export function callerRead(model: SpecModel): OperationModel | undefined {
	return model.operations.find((op) => op.identity === "self" && op.action === "read" && op.pathParams.length === 0)
}

export function invalidatesCaller(op: OperationModel, read: OperationModel): boolean {
	return op.invalidates.some((route) => route === `${read.method.toUpperCase()} ${read.path}` || route === read.route)
}
