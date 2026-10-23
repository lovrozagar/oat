/**
 * The operations that make and remove accounts. An account is a record oat cannot leave behind
 * quietly: it outlives the run, and a real backend may let it sign in, bill, or mail someone.
 */

import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { SELF_IDENTITY } from "../self/operations.ts"

/** How a run makes and removes accounts, read once from the document. */
export interface AccountOps {
	/** Whether sending `operationId` would make an account. */
	creates: (operationId: string | undefined) => boolean
	/** The caller deleting its own account: removes an account as the account itself. */
	deleteSelf: OperationModel | undefined
	/**
	 * The delete of the entity an account-making operation creates, and that entity's identity:
	 * removes an account by its id, as a principal allowed to.
	 */
	adminDelete: (operationId: string) => { op: OperationModel; identity: string } | undefined
}

/**
 * The operation the document marks `x-fresh-principal`, and any create of the `identity: self`
 * entity, make an account; whatever check, scene or sign-in sends one.
 */
export function makesAccount(op: OperationModel): boolean {
	return op.freshPrincipal || (op.action === "create" && op.identity === SELF_IDENTITY)
}

export function accountOps(model: SpecModel): AccountOps {
	const creating = new Set(model.operations.filter(makesAccount).map((op) => op.operationId))
	const deleteSelf = model.operations.find(
		(op) => op.identity === SELF_IDENTITY && op.action === "delete" && op.pathParams.length === 0,
	)
	const adminDelete = (operationId: string): { op: OperationModel; identity: string } | undefined => {
		const entity = model.entities.get(model.byOperationId.get(operationId)?.entity ?? "")
		if (entity === undefined || entity.identity === SELF_IDENTITY || entity.delete === undefined) return undefined
		/* An entity's delete names an operation of the model. */
		const op = model.byOperationId.get(entity.delete) as OperationModel
		return { identity: entity.identity ?? "id", op }
	}
	return {
		adminDelete,
		creates: (operationId) => operationId !== undefined && creating.has(operationId),
		deleteSelf,
	}
}
