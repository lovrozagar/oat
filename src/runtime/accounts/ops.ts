/**
 * The operations that make and remove accounts. An account is a record oat cannot leave behind
 * quietly: it outlives the run, and a real backend may let it sign in, bill, or mail someone.
 */

import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { type AccountMaking, accountMaking, SELF_IDENTITY } from "../../spec/sign-up.ts"
import type { Exchange } from "../exchange.ts"

/** How a run makes and removes accounts, read once from the document. */
export interface AccountOps {
	/** How sending `operationId` makes an account, if it can. */
	creates: (operationId: string | undefined) => AccountMaking
	/** Whether `exchange`, a send of `operationId`, made an account. */
	made: (operationId: string, exchange: Pick<Exchange, "schemes">) => boolean
	/** The caller deleting its own account: removes an account as the account itself. */
	deleteSelf: OperationModel | undefined
	/**
	 * The delete of the entity an account-making operation creates, and that entity's identity:
	 * removes an account by its id, as a principal allowed to.
	 */
	adminDelete: (operationId: string) => { op: OperationModel; identity: string } | undefined
}

/** Whether `exchange`, a send of `op`, made an account: a self create only when it carried no credential. */
export function madeAccount(op: OperationModel, model: SpecModel, exchange: Pick<Exchange, "schemes">): boolean {
	const making = accountMaking(op, model)
	return making === "always" || (making === "anonymously" && (exchange.schemes ?? []).length === 0)
}

export function accountOps(model: SpecModel): AccountOps {
	const opOf = (operationId: string | undefined): OperationModel | undefined =>
		operationId === undefined ? undefined : model.byOperationId.get(operationId)
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
		creates: (operationId) => {
			const op = opOf(operationId)
			return op === undefined ? null : accountMaking(op, model)
		},
		deleteSelf,
		made: (operationId, exchange) => {
			const op = opOf(operationId)
			return op !== undefined && madeAccount(op, model, exchange)
		},
	}
}
