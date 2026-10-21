/** The login throttle: under `throttleLogins`, an identity that keeps failing to sign in is told to wait. */

import type { ReferenceState } from "../state.ts"
import { type ReferenceResponse, respond } from "../wire.ts"

const WINDOW_MS = 60_000
const LIMIT = 5

/* Whether failed logins count at all on this server. */
const throttling = (state: ReferenceState): boolean => state.auth.throttle && !state.defects.has("LOGIN_NOT_THROTTLED")

/** The 429 a login for `identity` gets once it has failed 5 times within a minute; otherwise `undefined`. */
export function throttled(state: ReferenceState, identity: string): ReferenceResponse | undefined {
	if (!throttling(state)) return undefined
	const now = state.auth.clock()
	const recent = (state.auth.failures.get(identity) ?? []).filter((at) => at > now - WINDOW_MS)
	state.auth.failures.set(identity, recent)
	if (recent.length < LIMIT) return undefined
	const wait = Math.max(1, Math.ceil(((recent[0] as number) + WINDOW_MS - now) / 1000))
	return respond(
		429,
		{ error_key: "too_many_requests", message: "too many failed logins; retry later", status: 429, success: false },
		{ "retry-after": String(wait) },
	)
}

/** Records a login for `identity`: a failure counts toward the throttle, a success clears it. */
export function noteLogin(state: ReferenceState, identity: string, succeeded: boolean): void {
	if (!throttling(state)) return
	if (succeeded) state.auth.failures.delete(identity)
	else state.auth.failures.set(identity, [...(state.auth.failures.get(identity) ?? []), state.auth.clock()])
}
