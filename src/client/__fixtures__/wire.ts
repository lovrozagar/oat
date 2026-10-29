/** A `Wire` over a scripted transport, keeping what it delivers. */

import type { Exchange } from "../../runtime/exchange.ts"
import { Redactor } from "../../security/redact.ts"
import type { Wire } from "../attempt.ts"
import { createControls } from "../control.ts"
import { Slots } from "../slots.ts"
import type { Transport } from "./transport.ts"

export const BASE = "http://api.test/v1"

export interface Delivered {
	exchange: Exchange
	entity: string | undefined
}

export function wireOf(transport: Transport, more: Partial<Wire> = {}): Wire & { delivered: Delivered[] } {
	const delivered: Delivered[] = []
	let seq = 0
	return {
		baseUrl: BASE,
		/* off unless a test is about it: other tests assert a read's headers exactly */
		cacheBypass: false,
		controls: createControls(),
		credentials: undefined,
		deliver: async (exchange, entity) => {
			delivered.push({ entity, exchange })
		},
		delivered,
		fence: undefined,
		headers: {},
		httpHooks: undefined,
		network: { fetchImpl: transport.fetch },
		nextSeq: () => ++seq,
		operationResolver: undefined,
		rateLimiter: undefined,
		redactor: new Redactor(),
		relativePath: (url) => url.pathname.replace(/^\/v1/, "") || "/",
		resolveHeaders: undefined,
		slots: new Slots(4),
		...more,
	}
}
