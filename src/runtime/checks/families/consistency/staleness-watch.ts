/**
 * Read on a schedule until a read shows the write, and say where the window closed: the last read
 * that was still stale and the first that was not, in ms from the start of the watch. A stale read
 * at or past the cap ends it, whatever the schedule still holds. After the first stale read it asks
 * once whether a read past every cache shows the write: when none does, the write never took, and
 * waiting out the cap would only measure that.
 */

import type { Exchange } from "../../../exchange.ts"
import { sleep } from "../../../poll.ts"

export interface WatchClock {
	now: () => number
	sleep: (ms: number) => Promise<void>
}

export const SYSTEM_CLOCK: WatchClock = { now: () => performance.now(), sleep }

export interface Watch {
	/** Offsets in ms from the start, the first 0. */
	schedule: readonly number[]
	capMs: number
	read: () => Promise<Exchange>
	fresh: (answer: Exchange) => boolean
	clock: WatchClock
	/** Whether a read past every cache shows the write; asked once, after the first stale read. */
	showsPastCache?: () => Promise<boolean>
}

export interface Bracket {
	reads: number
	/** When the first read that showed the write went out; null when none did. */
	freshAtMs: number | null
	/** When the last read that did not went out, and its answer; null when the first was fresh. */
	staleAtMs: number | null
	stale: Exchange | null
	/** A read past every cache did not show the write either: no cache is to blame. */
	neverTook: boolean
}

export async function watchUntilFresh(watch: Watch): Promise<Bracket> {
	const start = watch.clock.now()
	const bracket: Bracket = { freshAtMs: null, neverTook: false, reads: 0, stale: null, staleAtMs: null }
	for (const offset of watch.schedule) {
		const wait = start + offset - watch.clock.now()
		if (wait > 0) await watch.clock.sleep(wait)
		const at = Math.round(watch.clock.now() - start)
		const answer = await watch.read()
		bracket.reads += 1
		if (watch.fresh(answer)) return { ...bracket, freshAtMs: at }
		const first = bracket.stale === null
		bracket.staleAtMs = at
		bracket.stale = answer
		if (first && watch.showsPastCache !== undefined && !(await watch.showsPastCache()))
			return { ...bracket, neverTook: true }
		if (at >= watch.capMs) break
	}
	return bracket
}
