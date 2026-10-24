/*
 * The records that hold a live credential the run depends on: each API key a security recipe minted,
 * say. A check may read one; it may never change or remove one, or the run would lock itself out
 * halfway through. Each is known by the mint answer that made it, its id read the way every created
 * id is (`createdIdOf`: the body by the entity's identity, or Location), so the rest of its entity
 * stays testable on records the run makes for its checks.
 */

import type { OperationModel, SpecModel } from "../spec/graph/types.ts"
import { createdIdOf } from "./created-id.ts"
import type { Exchange } from "./exchange.ts"

/** A record a credential recipe minted: its entity, its id, and the operation that minted it. */
export interface CredentialRecord {
	entity: string
	id: string
	operationId: string
}

/**
 * Every record a recipe's mint made, from the exchanges the credential store sent: those to a mint
 * operation that answered 2xx with an id. A mint whose answer names no id is not here; its entity
 * stays out of the run (`authOwnedReason`), rather than risk the credential.
 */
export function mintedRecords(input: {
	exchanges: readonly Exchange[]
	mintOps: ReadonlySet<string>
	model: Pick<SpecModel, "byOperationId" | "entities">
}): CredentialRecord[] {
	const { exchanges, mintOps, model } = input
	return exchanges.flatMap((exchange) => {
		const operationId = exchange.operationId
		if (exchange.issuedBy !== "credentials" || operationId === undefined || !mintOps.has(operationId)) return []
		if (exchange.status < 200 || exchange.status >= 300) return []
		const createOp = model.byOperationId.get(operationId)
		if (createOp === undefined || createOp.entity === null) return []
		const id = createdIdOf({ createOp, exchange, model, sent: exchange.requestBody })
		return id === undefined ? [] : [{ entity: createOp.entity, id: String(id.value), operationId }]
	})
}

/** The held record a request names by its resolved path, on that record's own entity; `undefined` when none. */
export function heldCredential(
	op: Pick<OperationModel, "entity">,
	pathParams: Readonly<Record<string, string>>,
	held: readonly CredentialRecord[],
): CredentialRecord | undefined {
	const named = new Set(Object.values(pathParams))
	return held.find((record) => record.entity === op.entity && named.has(record.id))
}
