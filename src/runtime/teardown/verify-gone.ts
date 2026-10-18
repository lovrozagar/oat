/**
 * The list a removed record lived in, read again with its creator's credential: a record still
 * listed is a leftover, whatever its delete answered. A read that cannot be sent — fenced, or the
 * network gone — verifies nothing and claims nothing.
 */

import type { SpecModel } from "../../spec/graph/types.ts"
import type { Client } from "../../client/client.ts"
import { fillPath } from "../fill-path.ts"
import { leftover } from "./remove.ts"
import { type ListGroup, stillListed } from "./still-listed.ts"
import type { Disposable, RecordState, TeardownReport } from "./types.ts"

export const STILL_LISTED = "delete answered 2xx but the record is still listed"

/** One level of the unwind, and the report its re-lists amend. */
export interface Relist {
	model: SpecModel
	client: Client
	queue: readonly Disposable[]
	records: ReadonlyMap<Disposable, RecordState>
	report: TeardownReport
}

export async function verifyGone(relist: Relist): Promise<void> {
	const { records, report } = relist
	for (const group of groupsOf(relist).values()) {
		const listed = await stillListed(relist.model, relist.client, group)
		if (listed === null) continue
		for (const item of group.items) {
			if (!listed.has(item.id)) continue
			/* Every record the unwind was given has its line. */
			const record = records.get(item) as RecordState
			record.removed = false
			report.removed -= 1
			report.failed.push(leftover(item, STILL_LISTED))
		}
	}
}

/** The removed records by the list each lived in, as its creator reads it. */
function groupsOf(relist: Relist): Map<string, ListGroup> {
	const { model } = relist
	const groups = new Map<string, ListGroup>()
	for (const item of relist.queue) {
		/* Every record the unwind was given has its line. */
		if (!(relist.records.get(item) as RecordState).removed) continue
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
