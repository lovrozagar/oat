/*
 * What the run knows of a minted credential's record, for the store's teardown revokes. The record
 * is the one its declared revoke removes: the revoke's entity, by the id that fills its path. An
 * accepted DELETE of it, by the revoke or the entity's own delete, already removed it; and a read
 * of it that answers 404 or 410, or a list it is missing from, shows it gone.
 */

import type { Client } from "../../client/client.ts"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import type { CredentialRecord, CredentialRecords } from "../../credentials/ports.ts"
import { isNetworkError } from "../../errors/network.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import { FencedError } from "../fence.ts"
import { fillPath } from "../fill-path.ts"
import { deletedEarlierIn, deleteOperationFor, readPathOf } from "../teardown/routes.ts"
import { stillListed } from "../teardown/still-listed.ts"
import type { Disposable } from "../teardown/types.ts"

export interface RecordsWiring {
	model: SpecModel
	/** The run's client, once connected. */
	client: () => Client
	/** The parameters bound for a principal, which a path fills from under the record's own. */
	scopeOf: (principal: string) => Readonly<Record<string, string>>
}

/* What a read answers for a record that is gone. */
const GONE: ReadonlySet<number> = /* @__PURE__ */ new Set([404, 410])

export function credentialRecords(wiring: RecordsWiring): CredentialRecords {
	return {
		gone: (record) => goneOnRead(wiring, record),
		removed: (record) => {
			const deleted = deletedEarlierIn(wiring.client().transcript)
			return removersOf(wiring, record).some((path) => deleted(path))
		},
	}
}

/* The record's own operations: the revoke, and its entity's delete. */
function operationsOf({ model }: RecordsWiring, record: CredentialRecord): OperationModel[] {
	/* Validation refuses a recipe naming an operation the document lacks. */
	const revoke = model.byOperationId.get(record.operationId) as OperationModel
	const remove = revoke.entity === null ? null : deleteOperationFor(revoke.entity, model)
	return remove === null || remove === revoke ? [revoke] : [remove, revoke]
}

function scopeOf(wiring: RecordsWiring, record: CredentialRecord): Record<string, string> {
	return { ...wiring.scopeOf(record.as.principal), ...record.scope }
}

/* The DELETE paths that remove the record. One with no path parameter names no record of its own. */
function removersOf(wiring: RecordsWiring, record: CredentialRecord): string[] {
	const scope = scopeOf(wiring, record)
	return operationsOf(wiring, record).flatMap((op) =>
		op.method !== "DELETE" || op.pathParams.length === 0 ? [] : (filled(op.path, scope) ?? []),
	)
}

/* The record as teardown names one: its entity and the id its own path takes last. */
function disposableOf(wiring: RecordsWiring, record: CredentialRecord): Disposable | null {
	const [op] = operationsOf(wiring, record) as [OperationModel]
	const scope = scopeOf(wiring, record)
	const id = scope[op.pathParams.at(-1) ?? ""]
	if (op.entity === null || id === undefined) return null
	return { entity: op.entity, id, owner: { id: record.as.principal }, scope }
}

/* A record shown gone; a read that cannot be sent or answers otherwise claims nothing. */
async function goneOnRead(wiring: RecordsWiring, record: CredentialRecord): Promise<boolean> {
	const item = disposableOf(wiring, record)
	if (item === null) return false
	const { model } = wiring
	const client = wiring.client()
	const read = readPathOf(model, item)
	if (read !== null) {
		const as = record.as
		const exchange = await sendable(() => client.get(read.path, { as, operationId: read.op.operationId }))
		return exchange !== null && GONE.has(exchange.status)
	}
	const entity = model.entities.get(item.entity)
	const listOp = entity?.list === undefined ? undefined : model.byOperationId.get(entity.list)
	const path = listOp === undefined ? undefined : filled(listOp.path, item.scope)
	if (listOp === undefined || path === undefined || entity?.identity == null) return false
	const group = { identity: entity.identity, items: [item], listOp, owner: item.owner, path }
	const listed = await stillListed(model, client, group)
	return listed !== null && !listed.has(item.id)
}

function filled(template: string, scope: Record<string, string>): string | undefined {
	try {
		return fillPath(template, scope)
	} catch {
		return undefined
	}
}

/* Null for a read that could not go: fenced, offline, or with no credential to send. */
async function sendable(send: () => Promise<Exchange>): Promise<Exchange | null> {
	try {
		return await send()
	} catch (error) {
		if (error instanceof FencedError || error instanceof UnsatisfiedSecurity || isNetworkError(error)) return null
		throw error
	}
}
