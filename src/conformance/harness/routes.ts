/** A suite's backend as a table of routes: the first whose method and path match answers. */

import type { Handle } from "../../reference/http/node.ts"
import type { ReferenceRequest, ReferenceResponse } from "../../reference/http/wire.ts"
import { answer } from "./serve.ts"

export interface Route {
	method: string
	/** Matched against the whole path. */
	path: RegExp
	/** `id` is the path's last capture group as sent, undecoded: the whole path when it captures none. */
	reply: (id: string, request: ReferenceRequest) => ReferenceResponse | Promise<ReferenceResponse>
}

/** Answers each request from the first matching route, and `fallback` (a bare 404) when none does. */
export function routed(routes: readonly Route[], fallback: ReferenceResponse = answer(404)): Handle {
	return async (request) => {
		for (const route of routes) {
			const match = route.method === request.method ? route.path.exec(request.url.pathname) : null
			/* A match always holds the whole path at 0, so its last entry is never missing. */
			if (match !== null) return route.reply(match.at(-1) as string, request)
		}
		return fallback
	}
}
