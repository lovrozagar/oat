/**
 * The security every conformance mini-document declares: one http bearer scheme, required at the
 * root, so each suite's config gives it a recipe the way a real user would. A suite about another
 * placement declares its own.
 */

import { bearer } from "../../reference/http/access.ts"
import type { Handle } from "../../reference/http/node.ts"
import { answer } from "./serve.ts"

/** The `components.securitySchemes` and root `security` a document spreads in, fresh each call. */
export function bearerSecurity(): {
	components: { securitySchemes: { bearer: { scheme: string; type: string } } }
	security: Array<Record<string, string[]>>
} {
	return { components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } }, security: [{ bearer: [] }] }
}

/**
 * `handle` behind the bearer `token`, the backend half of `bearerSecurity`: a request without that
 * token answers 401, as the root requirement says it must. The document itself stays public.
 */
export function bearerGuarded(handle: Handle, token: string): Handle {
	return async (request) => {
		const isDocument = request.method === "GET" && request.url.pathname === "/v1/openapi/spec"
		if (isDocument || bearer(request) === token) return handle(request)
		return answer(401, { error_key: "unauthorized" })
	}
}
