/**
 * A token bucket with a queue: concurrent requests against the same category are admitted one at
 * a time, each computing its wait from the bucket's current state rather than racing on it.
 * Burst capacity equals `rps` — up to one second's worth of headroom, the conventional default.
 */
export class RateBucket {
	private tokens: number
	private last = performance.now()
	private cooldownUntil = 0
	private queue: Promise<void> = Promise.resolve()

	constructor(private readonly rps: number) {
		this.tokens = rps
	}

	/**
	 * A 429 said this budget is exhausted. Hold the next acquire for `waitMs`, then admit exactly
	 * one request — a full burst refill would immediately re-trip the limit we just hit.
	 */
	penalize(waitMs: number): void {
		const until = performance.now() + Math.max(0, waitMs)
		this.cooldownUntil = Math.max(this.cooldownUntil, until)
		this.tokens = 1
		this.last = this.cooldownUntil
	}

	/** Resolves once a token is consumed. Returns `false` when the caller had to wait for it. */
	async acquire(): Promise<boolean> {
		let hadRoom = false
		const previous = this.queue
		this.queue = previous.then(async () => {
			const now = performance.now()
			if (now < this.cooldownUntil) {
				await new Promise<void>((resolve) => setTimeout(resolve, this.cooldownUntil - now))
			}
			const after = performance.now()
			this.tokens = Math.min(this.rps, this.tokens + ((after - this.last) / 1000) * this.rps)
			this.last = after
			if (this.tokens >= 1) {
				/* A cooldown wait is not room — oat did not believe it was under its own pace. */
				hadRoom = now >= this.cooldownUntil
				this.tokens -= 1
				return
			}
			const waitMs = ((1 - this.tokens) / this.rps) * 1000
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
			this.tokens = 0
			this.last = performance.now()
			hadRoom = false
		})
		await this.queue
		return hadRoom
	}
}
