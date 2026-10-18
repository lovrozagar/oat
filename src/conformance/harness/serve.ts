/**
 * A suite's own backend, written as a `Handle`: whatever `Via` the suite runs on then decides
 * whether a socket stands in front of it.
 */

import type { Handle } from "../../reference/http/node.ts"
import { type ReferenceRequest, type ReferenceResponse, respond } from "../../reference/http/wire.ts"

/** A JSON answer, or a bare status (with any `headers`) when there is no body. */
export function answer(status: number, body?: unknown, headers: Record<string, string> = {}): ReferenceResponse {
	return body === undefined ? { body: "", headers, status } : respond(status, body, headers)
}

/** The request body as JSON; an empty body is `undefined`, and a malformed one rejects. */
export async function readJson(request: ReferenceRequest): Promise<unknown> {
	const text = await request.text()
	return text === "" ? undefined : (JSON.parse(text) as unknown)
}

/** `handle`, answering `failure` when it throws instead of leaving the request unanswered. */
export function guarded(handle: Handle, failure: ReferenceResponse = answer(500)): Handle {
	return async (request) => {
		try {
			return await handle(request)
		} catch {
			return failure
		}
	}
}
