/** An exchange as the client records it, with whatever a test needs changed. */

import type { Exchange } from "../../exchange.ts"

export function exchangeOf(overrides: Partial<Exchange> = {}): Exchange {
	return {
		at: 1_800_000_000_000,
		durationMs: 12,
		method: "GET",
		requestBody: undefined,
		requestBytes: 40,
		requestHeaders: { accept: "application/json" },
		requestId: "req-1",
		responseBody: { ok: true },
		responseBytes: 80,
		responseHeaders: { "content-type": "application/json" },
		seq: 1,
		status: 200,
		url: "http://h.test/v1/items",
		...overrides,
	}
}
