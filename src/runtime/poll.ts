/**
 * Shared exponential backoff for values that arrive outside the request that needs them.
 *
 * Mail catchers, TOTP harvest pages, and human OAuth clicks are eventually consistent. oat
 * owns the sleep schedule so a hook only has to read the store and return `null` until a
 * value is there.
 */

export interface BackoffConfig {
	/** Inclusive probe count. Defaults to 6. */
	attempts: number
	/** First sleep after a miss, in ms. Defaults to 200. */
	initialMs: number
	/** Ceiling for the doubled sleep, in ms. Defaults to 3000. */
	maxMs: number
}

export const DEFAULT_OUT_OF_BAND: BackoffConfig = {
	attempts: 6,
	initialMs: 200,
	maxMs: 3000,
}

export function resolveBackoff(config?: Partial<BackoffConfig>): BackoffConfig {
	return {
		attempts: positiveInt(config?.attempts, DEFAULT_OUT_OF_BAND.attempts),
		initialMs: positiveInt(config?.initialMs, DEFAULT_OUT_OF_BAND.initialMs),
		maxMs: positiveInt(config?.maxMs, DEFAULT_OUT_OF_BAND.maxMs),
	}
}

function positiveInt(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
	return Math.floor(value)
}

/**
 * Sleep after every failed probe, including the last — that is the 0.6.2 schedule, so an
 * unchanged config still waits ~9s worst case (200+400+800+1600+3000+3000).
 */
export function backoffDelays(config: BackoffConfig): number[] {
	const delays: number[] = []
	let delay = config.initialMs
	for (let i = 0; i < config.attempts; i++) {
		delays.push(delay)
		delay = Math.min(delay * 2, config.maxMs)
	}
	return delays
}

/** Sum of every sleep in the schedule. Hook work is not included. */
export function worstCaseWaitMs(config?: Partial<BackoffConfig>): number {
	return backoffDelays(resolveBackoff(config)).reduce((sum, delay) => sum + delay, 0)
}

/** `null` and `""` mean "not yet" — the store is empty, not that delivery failed. */
export function isAbsentValue(value: unknown): boolean {
	return value === null || value === ""
}

export async function pollWithBackoff<T>(
	probe: (attempt: number) => Promise<T>,
	config: BackoffConfig,
	absent: (value: T) => boolean = isAbsentValue,
): Promise<T | undefined> {
	const delays = backoffDelays(config)
	for (const [index, wait] of delays.entries()) {
		const value = await probe(index + 1)
		if (!absent(value)) return value
		await sleep(wait)
	}
	return undefined
}

export function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms))
}
