/**
 * `hooks.verifyRemoved`: the product's own word on whether a record is gone, asked about every
 * record counted removed and every one never seen.
 */

import type { RemovalVerdict } from "../../config/types/hooks.ts"
import { NEVER_SEEN } from "./never-seen.ts"
import { leftover } from "./remove.ts"
import { keyOf, recordKey } from "./routes.ts"
import type { Disposable, RecordState, TeardownReport, UnwindOptions } from "./types.ts"

export const VERIFY_HOOK_PRESENT = "hooks.verifyRemoved says it is still present"

/* Calls to `hooks.verifyRemoved` at once. */
const VERIFY_HOOK_CONCURRENCY = 4

/** The unwind's records, the ones never seen, and the report the verdicts amend. */
export interface Verdicts {
	queue: readonly Disposable[]
	records: ReadonlyMap<Disposable, RecordState>
	neverSeen: ReadonlySet<Disposable>
	report: TeardownReport
}

/**
 * Applies `hooks.verifyRemoved` to every record counted removed and every one never seen, a few at
 * a time: `present` makes a leftover, `absent` clears a never-seen record, `unknown` — or a throw —
 * leaves teardown's own verdict.
 */
export async function askVerifyHook(
	hook: NonNullable<UnwindOptions["verifyRemoved"]>,
	verdicts: Verdicts,
): Promise<void> {
	const { neverSeen, records, report } = verdicts
	/* Every record the unwind was given has its line. */
	const recordOf = (item: Disposable): RecordState => records.get(item) as RecordState
	const asked = verdicts.queue.filter((item) => recordOf(item).removed || neverSeen.has(item))
	const errors: string[] = []
	const answer = async (item: Disposable): Promise<RemovalVerdict> => {
		try {
			return await hook({ entity: item.entity, id: item.id, principal: item.owner.id, scope: { ...item.scope } })
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error))
			return "unknown"
		}
	}
	for (let at = 0; at < asked.length; at += VERIFY_HOOK_CONCURRENCY) {
		const batch = asked.slice(at, at + VERIFY_HOOK_CONCURRENCY)
		const answers = await Promise.all(batch.map(answer))
		batch.forEach((item, index) => apply(report, { item, record: recordOf(item), verdict: answers[index] }))
	}
	if (errors.length > 0) report.verifyHookErrors = errors
}

/** One verdict on one record: `absent` clears its never-seen leftover, `present` makes it a leftover. */
function apply(
	report: TeardownReport,
	answered: { item: Disposable; record: RecordState; verdict: RemovalVerdict | undefined },
): void {
	const { item, record, verdict } = answered
	if (verdict === "unknown") return
	const failure = report.failed.findIndex(
		(entry) => recordKey(entry.entity, entry.id, entry.principal) === keyOf(item) && entry.reason === NEVER_SEEN,
	)
	if (verdict === "absent") {
		if (failure < 0) return
		report.failed.splice(failure, 1)
		record.removed = true
		report.removed += 1
		return
	}
	if (failure >= 0) report.failed.splice(failure, 1)
	else {
		record.removed = false
		report.removed -= 1
	}
	report.failed.push(leftover(item, VERIFY_HOOK_PRESENT))
}
