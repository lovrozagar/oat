/** Who a request acts as, by the credential its Authorization header carries: a bearer JWT or an API key. */

import { HttpError } from "../errors.ts"
import type { ReferenceState } from "../state.ts"
import type { ReferenceRequest } from "../wire.ts"
import { type ApiKeyNeed, apiKeyPrincipal } from "./api-keys.ts"
import { accessPrincipal } from "./sessions.ts"
import type { Principal } from "./types.ts"

export type { ApiKeyNeed } from "./api-keys.ts"

/**
 * The caller. Every secured route takes a bearer JWT; a route that also takes an API key passes what
 * it asks of one as `need`, and any other route refuses keys.
 */
export function authenticate(state: ReferenceState, request: ReferenceRequest, need?: ApiKeyNeed): Principal {
	const [scheme = "", value = ""] = (request.headers.authorization ?? "").trim().split(/\s+/, 2)
	if (value === "") throw new HttpError(401, "unauthorized", "missing credential")
	switch (scheme.toLowerCase()) {
		case "bearer":
			return accessPrincipal(state, value)
		case "apikey":
			return keyHolder(state, value, need)
		default:
			throw new HttpError(401, "unauthorized", "unsupported credential scheme")
	}
}

/* An API key's holder, where this route lets one in. */
function keyHolder(state: ReferenceState, value: string, need: ApiKeyNeed | undefined): Principal {
	const { defects } = state
	if (need === undefined && !defects.has("ANY_SCHEME_ACCEPTED")) {
		throw new HttpError(401, "unauthorized", "this operation does not accept an API key")
	}
	if (need !== undefined && defects.has("APIKEY_ALTERNATIVE_BROKEN")) {
		throw new HttpError(401, "unauthorized", "API keys are not accepted here")
	}
	return apiKeyPrincipal(state, value, need)
}
