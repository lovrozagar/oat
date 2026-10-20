/** A 401 on a request that carried a principal's credential: renew it once, and ask once more. */

import type { Exchange } from "../runtime/exchange.ts"

/** What a request does once more after a 401. */
export interface Reauthorize {
	/** Renews the credential the refused attempt carried; false when this request may not renew. */
	renew: () => Promise<boolean>
	supersede: (exchange: Exchange) => void
	send: () => Promise<Exchange>
	/** A 401 not renewed, or a renewal refused too: the control decides whether the principal or the route refused it. */
	refused: (exchange: Exchange) => Promise<void>
}

/** `exchange`, or, when it is a 401 the request may renew its credential for, the answer after the renewal. */
export async function afterUnauthorized(exchange: Exchange, again: Reauthorize): Promise<Exchange> {
	if (exchange.status !== 401) return exchange
	if (!(await again.renew())) {
		await again.refused(exchange)
		return exchange
	}
	again.supersede(exchange)
	const resent = await again.send()
	if (resent.status === 401) await again.refused(resent)
	return resent
}
