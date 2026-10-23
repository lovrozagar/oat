/**
 * The list a removed record lived in, read again with its creator's credential: a record still
 * listed is a leftover, whatever its delete answered. A record whose entity has no list is read
 * back by its item read instead: a 2xx is a leftover, a 404 or 410 shows it gone. A read that
 * cannot be sent — fenced, or the network gone — verifies nothing and claims nothing.
 */

import type { SpecModel } from "../../spec/graph/types.ts"
import type { Client } from "../../client/client.ts"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { isNetworkError } from "../../errors/network.ts"
import { FencedError } from "../fence.ts"
import { fillPath } from "../fill-path.ts"
import { leftover } from "./remove.ts"
import { readPathOf } from "./routes.ts"
import { type ListGroup, stillListed } from "./still-listed.ts"
import type { Disposable, RecordState, TeardownReport } from "./types.ts"

export const STILL_LISTED = "delete answered 2xx but the record is still listed"
export const STILL_READS = "delete answered 2xx but the record still reads back"

/** One level of the unwind, and the report its re-lists amend. */
export interface Relist {
	model: SpecModel
	client: Client
	queue: readonly Disposable[]
	records: ReadonlyMap<Disposable, RecordState>
	report: TeardownReport
}

export async function verifyGone(relist: Relist): Promise<void> {
	for (const group of groupsOf(relist).values()) {
		const listed = await stillListed(relist.model, relist.client, group)
		if (listed === null) continue
		for (const item of group.items) if (listed.has(item.id)) stillThere(relist, item, STILL_LISTED)
	}
	const unlisted = relist.queue.filter(
		(item) => removed(relist, item) && relist.model.entities.get(item.entity)?.list === undefined,
	)
	const reads = await Promise.all(unlisted.map((item) => readsBack(relist, item)))
	unlisted.forEach((item, at) => {
		if (reads[at] === true) stillThere(relist, item, STILL_READS)
	})
}

/* Every record the unwind was given has its line. */
const removed = (relist: Relist, item: Disposable): boolean => (relist.records.get(item) as RecordState).removed

/** A record counted removed that is still there: a leftover after all. */
function stillThere(relist: Relist, item: Disposable, reason: string): void {
	;(relist.records.get(item) as RecordState).removed = false
	relist.report.removed -= 1
	relist.report.failed.push(leftover(item, reason))
}

/**
 * Whether the record still reads back as its creator. Only a 2xx says it does; a record with no
 * read to fill, a read that cannot be sent, or any other answer claims nothing.
 */
async function readsBack(relist: Relist, item: Disposable): Promise<boolean> {
	const read = readPathOf(relist.model, item)
	if (read === null) return false
	try {
		const exchange = await relist.client.get(read.path, {
			as: { principal: item.owner.id },
			operationId: read.op.operationId,
		})
		return exchange.status >= 200 && exchange.status < 300
	} catch (error) {
		if (!(error instanceof FencedError) && !(error instanceof UnsatisfiedSecurity) && !isNetworkError(error))
			throw error
		return false
	}
}

/** The removed records by the list each lived in, as its creator reads it. */
function groupsOf(relist: Relist): Map<string, ListGroup> {
	const { model } = relist
	const groups = new Map<string, ListGroup>()
	for (const item of relist.queue) {
		if (!removed(relist, item)) continue
		const entity = model.entities.get(item.entity)
		const listOp = entity?.list === undefined ? undefined : model.byOperationId.get(entity.list)
		if (entity === undefined || listOp === undefined || entity.identity === null) continue
		let path: string
		try {
			path = fillPath(listOp.path, item.scope)
		} catch {
			continue
		}
		const key = `${item.entity}\u0000${path}\u0000${item.owner.id}`
		const group = groups.get(key) ?? { identity: entity.identity, items: [], listOp, owner: item.owner, path }
		group.items.push(item)
		groups.set(key, group)
	}
	return groups
}
