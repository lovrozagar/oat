/**
 * The unwind: deepest records first, one level at a time, every record within a level at once.
 * A record's depth is how many path parameters its delete route takes: a child's route carries
 * its parent's parameters and its own, so a level never holds a record and its parent. Newest
 * first within a level keeps the order the creation sequence implies.
 */

import type { SpecModel } from "../../spec/graph/types.ts"
import type { Client } from "../../client/client.ts"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { FencedError } from "../fence.ts"
import { isNetworkError } from "../../errors/network.ts"
import { markNeverSeen } from "./never-seen.ts"
import { removeOne, type Unwind } from "./remove.ts"
import { deletedEarlierIn, deleteOperationFor, readPathOf } from "./routes.ts"
import type { Disposable, LedgerView, Owner, RecordState, TeardownReport, UnwindOptions } from "./types.ts"
import { askVerifyHook } from "./verify-hook.ts"
import { verifyGone } from "./verify-gone.ts"

export interface UnwindInput {
	model: SpecModel
	client: Client
	fallbacks: (owner: Owner) => Owner[]
	options: UnwindOptions
	/** The records to remove, newest first. */
	queue: readonly Disposable[]
	ledger: LedgerView
}

export async function unwindQueue(input: UnwindInput): Promise<TeardownReport> {
	const { client, ledger, model, options, queue } = input
	const { verify = true } = options
	const report: TeardownReport = { failed: [], records: [], removed: 0, unidentified: [], unsupported: [] }
	const records = new Map<Disposable, RecordState>(
		queue.map((item) => [item, { entity: item.entity, id: item.id, principal: item.owner.id, removed: false }]),
	)
	const state: Unwind = {
		client,
		deletedEarlier: deletedEarlierIn(client.transcript),
		done: 0,
		fallbacks: input.fallbacks,
		ledger,
		model,
		onItem: options.onItem,
		paths: new Map(),
		records,
		report,
		total: queue.length,
		unsupported: new Set(),
	}
	const depthOf = (item: Disposable): number => deleteOperationFor(item.entity, model)?.pathParams.length ?? 0
	const levels = [...new Set(queue.map(depthOf))].sort((a, b) => b - a)
	for (const level of levels) {
		const removing = queue.filter((item) => depthOf(item) === level)
		/* A record its creator never read back is read once, as its creator. */
		await Promise.all(removing.filter((item) => !ledger.seenByCreator(item)).map((item) => readBack(state, item)))
		await Promise.all(removing.map((item) => removeOne(state, item)))
		/* Before the parents go: a removed parent takes with it the list its children are read in. */
		if (verify) await verifyGone({ client, model, queue: removing, records, report })
	}

	const neverSeen = markNeverSeen(state, queue)
	if (options.verifyRemoved !== undefined) {
		await askVerifyHook(options.verifyRemoved, { neverSeen, queue, records, report })
	}
	report.unsupported = [...state.unsupported]
	report.records = [...records.values()].toReversed()
	return report
}

/*
 * One read of the record as its creator; a 2xx is the sighting it lacked. A read that cannot go,
 * fenced, offline, or as a creator with no credential to send, leaves it unsighted.
 */
async function readBack(state: Unwind, item: Disposable): Promise<void> {
	const read = readPathOf(state.model, item)
	if (read === null) return
	try {
		const exchange = await state.client.get(read.path, {
			as: { principal: item.owner.id },
			operationId: read.op.operationId,
		})
		if (exchange.status >= 200 && exchange.status < 300) state.ledger.sighted(item.entity, item.id, item.owner.id)
	} catch (error) {
		if (!(error instanceof FencedError) && !(error instanceof UnsatisfiedSecurity) && !isNetworkError(error))
			throw error
	}
}
