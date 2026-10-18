/**
 * A record gone by every sign HTTP gives, yet its creator never saw it: no sign could have shown
 * it gone, so it is not counted removed.
 */

import { type Unwind, leftover } from "./remove.ts"
import { readPathOf } from "./routes.ts"
import type { Disposable, RecordState } from "./types.ts"

export const NEVER_SEEN = "its creator could never read it back, so teardown cannot tell whether it is gone"

/** Moves each such record from removed to leftover; returns them. */
export function markNeverSeen(state: Unwind, queue: readonly Disposable[]): Set<Disposable> {
	const { model, report } = state
	const neverSeen = new Set<Disposable>()
	for (const item of queue) {
		/* Every record the unwind was given has its line. */
		const record = state.records.get(item) as RecordState
		if (!record.removed || state.ledger.seenByCreator(item) || readPathOf(model, item) === null) continue
		/* A removed record was sent its delete. */
		if (state.deletedEarlier(state.paths.get(item) as string)) continue
		record.removed = false
		report.removed -= 1
		report.failed.push(leftover(item, NEVER_SEEN))
		neverSeen.add(item)
	}
	return neverSeen
}
