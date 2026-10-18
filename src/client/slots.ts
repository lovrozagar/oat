/** Admission control: at most `size` requests in flight, the rest waiting in order. */
export class Slots {
	private inFlight = 0
	private readonly waiting: Array<() => void> = []

	constructor(private readonly size: number) {}

	/** Held for the duration of one attempt, and released in a finally. */
	async acquire(): Promise<void> {
		if (this.inFlight >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve))
		this.inFlight += 1
	}

	release(): void {
		this.inFlight -= 1
		this.waiting.shift()?.()
	}
}
