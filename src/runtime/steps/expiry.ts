/*
 * When an issued credential expires. Prefer what the API states, then what the credential itself
 * carries, then the configured fallback. Guessing an expiry that is too long means requests start
 * failing mid-run for reasons that look like backend defects.
 */

import { readPath } from "../../client/read-path.ts"
import { jwtExpiryMs } from "./jwt.ts"

/** Where a flow states its credential's lifetime, and the lifetime it assumes otherwise. */
export interface ExpiryRule {
	/** Lifetime in seconds at this path of the issuing answer's body. */
	expiresInFrom?: string
	assumeTtlMs?: number
}

/** Unix milliseconds the credential expires at, from `body` (the issuing answer's), or null. */
export function computeExpiry(rule: ExpiryRule, body: unknown, credential: string): number | null {
	if (rule.expiresInFrom !== undefined) {
		const seconds = readPath(body, rule.expiresInFrom)
		if (typeof seconds === "number") return Date.now() + seconds * 1000
	}
	const fromJwt = jwtExpiryMs(credential)
	if (fromJwt !== null) return fromJwt
	if (rule.assumeTtlMs !== undefined) return Date.now() + rule.assumeTtlMs
	return null
}
