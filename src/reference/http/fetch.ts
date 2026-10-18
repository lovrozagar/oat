/** A handler as a transport: the client hands it each request, and no socket stands between them. */

import type { Handle } from "./node.ts"
import { referenceRequest } from "./wire.ts"

export function asFetch(handle: Handle): typeof fetch {
	return async (input, init) => {
		/* A streamed body must say it is sent half-duplex; any other body is unaffected. */
		const request = new Request(input, { ...init, duplex: "half" } as RequestInit)
		const read = (): Promise<string> => request.text()
		const answer = await handle(
			referenceRequest(request.method, new URL(request.url), Object.fromEntries(request.headers), read),
		)
		return new Response(answer.status === 204 ? null : answer.body, { headers: answer.headers, status: answer.status })
	}
}
