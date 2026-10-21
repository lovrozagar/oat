/*
 * A create whose body requires a property marked `x-privileged` can be sent by the highest rank alone:
 * an ordinary body leaves an optional one out, but a required one must go, and only that rank may set
 * it. Anyone else's create is a guaranteed refusal, so it is never sent; it is untested with the reason.
 */

import type { OperationModel } from "../spec/graph/types.ts"

/** A principal as the rule reads it. */
export interface Ranked {
	id: string
	rank: number
	tenant?: string | undefined
}

/**
 * Why `sender` must not send `createOp`, or undefined when it may: the body requires an x-privileged
 * property and a principal of the sender's tenant outranks it.
 */
export function privilegedBar(
	createOp: Pick<OperationModel, "operationId" | "privilegedRequired">,
	sender: Ranked,
	principals: readonly Ranked[],
): string | undefined {
	if (createOp.privilegedRequired.length === 0) return undefined
	const top = principals
		.filter((principal) => principal.tenant === sender.tenant)
		.reduce((highest, principal) => (principal.rank > highest.rank ? principal : highest), sender)
	if (top.rank <= sender.rank) return undefined
	return (
		`${createOp.operationId} requires ${createOp.privilegedRequired.join(", ")}, marked x-privileged, which ` +
		`only ${top.id} (rank ${top.rank}) may set; ${sender.id} (rank ${sender.rank}) does not send it`
	)
}
