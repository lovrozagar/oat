/**
 * Ledgers every create a configured principal sends, as that principal, from the answer itself.
 *
 * Recording at each call site missed whatever a site did not foresee: a probe that writes under
 * another tenant's root, a create declared as PUT, a scenario's create. Every view's request
 * passes through `Client.request`, so the tracker reads each answer there, before the caller sees
 * it: a create the backend accepted becomes a record of whoever's credential it carried, scoped
 * where its own path put it.
 */

import type { OperationModel, SpecModel } from "../spec/graph.ts"
import { pathTemplateParams } from "../spec/load.ts"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { returnedId } from "./proven-id.ts"
import { SELF_IDENTITY } from "./self.ts"
import type { Ledger, Owner } from "./teardown.ts"
import { createdRecord, idOf, recordsFromList } from "./world.ts"

/** A configured principal as the tracker needs it: who removes the record, and its roots. */
export interface TrackedOwner {
	owner: Owner
	/** The principal's root values: path parameters a create's own path may not name. */
	roots: Record<string, string>
}

export function createTracker(input: {
	model: SpecModel
	ledger: Ledger
	/** Configured principals by id. A credential none of them holds is not tracked. */
	owners: ReadonlyMap<string, TrackedOwner>
	client: Client
	readable: (op: OperationModel) => boolean
	/** Called with every record the tracker ledgers. */
	onRecorded?: (entity: string, id: string) => void
}): { observe: (exchange: Exchange) => Promise<void> } {
	const { ledger, model } = input
	/* Each entity's create, read and list, by operation. The caller's own account is teardownPrincipal's. */
	const creates = new Map<string, { entity: string; identity: string; op: OperationModel }>()
	const reads = new Map<string, { entity: string; op: OperationModel }>()
	const lists = new Map<string, { entity: string; identity: string; op: OperationModel }>()
	for (const entity of model.entities.values()) {
		if (entity.identity === SELF_IDENTITY) continue
		const identity = entity.identity ?? "id"
		const create = entity.create === undefined ? undefined : model.byOperationId.get(entity.create)
		if (create !== undefined) creates.set(create.operationId, { entity: entity.name, identity, op: create })
		const read = entity.read === undefined ? undefined : model.byOperationId.get(entity.read)
		if (read !== undefined) reads.set(read.operationId, { entity: entity.name, op: read })
		const list = entity.list === undefined ? undefined : model.byOperationId.get(entity.list)
		if (list !== undefined) lists.set(list.operationId, { entity: entity.name, identity, op: list })
	}

	/* The parameters an exchange's path gave the operation's own template. */
	const paramsOf = (exchange: Exchange, op: OperationModel): Record<string, string> | null =>
		exchange.template === op.path && exchange.pathParams !== undefined
			? exchange.pathParams
			: pathTemplateParams(op.path, input.client.relativePath(exchange.url))

	/* A principal read records back: under the read's id, or as the rows of a listing. */
	const sight = (exchange: Exchange, principal: string): void => {
		const operationId = exchange.operationId ?? ""
		const read = reads.get(operationId)
		if (read !== undefined) {
			const param = read.op.pathParams.at(-1)
			const id = param === undefined ? undefined : paramsOf(exchange, read.op)?.[param]
			if (id !== undefined) ledger.sighted(read.entity, id, principal)
			return
		}
		const list = lists.get(operationId)
		if (list === undefined) return
		for (const row of recordsFromList(exchange.responseBody, list.op.collection?.key ?? null)) {
			const id = idOf(row, list.identity)
			if (id !== undefined) ledger.sighted(list.entity, id, principal)
		}
	}

	const observe = async (exchange: Exchange): Promise<void> => {
		if (exchange.status < 200 || exchange.status >= 300) return
		/* Teardown reads back what it needs itself. */
		if (exchange.purpose === "teardown") return
		const owned = exchange.principal === undefined ? undefined : input.owners.get(exchange.principal)
		if (owned === undefined) return
		if (exchange.method === "GET") {
			sight(exchange, owned.owner.id)
			return
		}
		/* Seeding ledgers each create it makes through its own callbacks. */
		if (exchange.purpose === "seed") return
		const create = exchange.operationId === undefined ? undefined : creates.get(exchange.operationId)
		if (create === undefined) return
		const { entity, identity, op } = create
		/* The exchange's parameters belong to the template it resolved to: the create's, unless the
		 * caller named the create for another path. */
		const params = paramsOf(exchange, op)
		if (params === null) {
			ledger.unidentified(entity, op.operationId, exchange)
			return
		}
		/* Where the record lives is where its path put it: a root the path names is the path's. */
		const scope = { ...owned.roots, ...params }
		const made = await createdRecord({
			client: input.client.view({ purpose: "assertion", subject: entity }),
			createOp: op,
			exchange,
			headers: owned.owner.headers,
			model,
			readable: input.readable,
			scope,
			sent: exchange.requestBody,
		})
		const id = made === null ? undefined : returnedId(made.record, identity)
		/* An empty identity names nothing a delete could reach. */
		if (id === undefined || id === "") {
			ledger.unidentified(entity, op.operationId, exchange)
			return
		}
		ledger.record(entity, id, scope, owned.owner)
		input.onRecorded?.(entity, id)
	}
	return { observe }
}
