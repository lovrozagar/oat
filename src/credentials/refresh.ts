/*
 * When a held credential is renewed, and how often. A credential is stale once it is within the
 * buffer of lapsing, so a request never leaves with one that lapses in flight. A renewal is
 * single-flight per held credential: however many callers find it stale or refused at once, one
 * renewal runs and they all share its result. The renewals live on the store a run creates.
 * The buffer is at most half the credential's lifetime, so a 30 s TOTP code or a short JWT is not
 * stale the moment it is issued.
 */

/** How long before it lapses a credential counts as stale. */
export const DEFAULT_REFRESH_BUFFER_MS = 30_000

/** Whether a credential issued at `issuedAt` and lapsing at `expiresAt` is due for renewal at `now`. */
export function isStale(
	held: { expiresAt: number | null; issuedAt: number },
	at: { now: number; bufferMs: number },
): boolean {
	if (held.expiresAt === null) return false
	const buffer = Math.min(at.bufferMs, (held.expiresAt - held.issuedAt) / 2)
	return held.expiresAt - buffer <= at.now
}

/** A single-flight renewal per held entry: the first caller starts it, the rest share it. */
export function createRenewals<E extends object, R>(): (held: E, start: () => Promise<R>) => Promise<R> {
	const renewals = new WeakMap<E, Promise<R>>()
	return (held, start) => {
		const running = renewals.get(held)
		if (running !== undefined) return running
		const renewal = start()
		renewals.set(held, renewal)
		return renewal
	}
}
