/**
 * When `consistency.staleness-within-bound` reads after a write, as offsets in ms from the write's
 * answer. It reads at once, so a fresh API costs one read; then it backs off, the first gap
 * min(250 ms, cap / 10), each next one doubled and none over cap / 4, until a read lands at or past
 * the cap. Twelve reads at most: a day-long bound must not cost a day of polling.
 */

export const MAX_STALENESS_READS = 12
/** How long a read that declares no staleness is watched: long enough to see a cache, never failed. */
export const UNDECLARED_CAP_MS = 10_000
const FIRST_GAP_MS = 250

export function stalenessSchedule(capMs: number): number[] {
	const ceiling = capMs / 4
	const offsets = [0]
	let gap = Math.min(FIRST_GAP_MS, capMs / 10)
	while (offsets.length < MAX_STALENESS_READS && (offsets.at(-1) as number) < capMs) {
		offsets.push((offsets.at(-1) as number) + gap)
		gap = Math.min(gap * 2, ceiling)
	}
	return offsets
}
