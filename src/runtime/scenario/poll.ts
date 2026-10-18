/**
 * A polled step's window and the wait between its sends.
 */

/** `"30s"`, `"500ms"`, `"2m"`. */
export function durationMs(text: string): number {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(text.trim())
	if (match === null) throw new Error(`oat: "${text}" is not a duration (use 500ms, 30s or 2m)`)
	const value = Number(match[1])
	return match[2] === "ms" ? value : match[2] === "s" ? value * 1000 : value * 60_000
}

/** The wait before the next poll: doubling to five seconds, never shorter than the interval asked for. */
export function nextPollWait(current: number, everyMs: number): number {
	return Math.min(current * 2, Math.max(5_000, everyMs))
}

/** The wait a run makes when no `sleep` is given. */
export function wait(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
