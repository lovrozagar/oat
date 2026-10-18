/** Keeping a principal's credential alive across a request: refresh when stale, once more on a 401. */

import { messageOf } from "../errors/message.ts"
import type { Exchange } from "../runtime/exchange.ts"

/** Refreshing a principal's credential failed; `principal` names it when known. */
export class AuthRefreshError extends Error {
	constructor(
		readonly principal: string | undefined,
		readonly reason: unknown,
	) {
		super(
			`refreshing the credential${principal === undefined ? "" : ` of "${principal}"`} failed: ${messageOf(reason)}`,
		)
		this.name = "AuthRefreshError"
	}
}

export type Refresh = (force?: boolean) => Promise<void>

/**
 * `refresh`, with its failure raised as the principal's. A refresh that fails is the backend's
 * failure to keep a session alive, not this request's: the run reports it rather than losing it in
 * a check.
 */
export function refreshing(refresh: Refresh, principal: () => string | undefined): Refresh {
	return async (force) => {
		try {
			await refresh(force)
		} catch (error) {
			throw new AuthRefreshError(principal(), error)
		}
	}
}

/** What a request does once more after a 401. */
export interface Reauthorize {
	refresh: Refresh | undefined
	supersede: (exchange: Exchange) => void
	send: () => Promise<Exchange>
}

/** `exchange`, or — when it is a 401 and the credential can be refreshed — the answer after one forced refresh. */
export async function afterUnauthorized(exchange: Exchange, again: Reauthorize): Promise<Exchange> {
	if (exchange.status !== 401 || again.refresh === undefined) return exchange
	again.supersede(exchange)
	await again.refresh(true)
	return again.send()
}
