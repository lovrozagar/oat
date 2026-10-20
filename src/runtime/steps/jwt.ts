/*
 * Where a step finds the token to read claims from. The claims themselves decode in
 * credentials/jwt.ts, the one reader every caller shares.
 */

import { readPath } from "../../client/read-path.ts"

/** JWT from a JSON body path, or a scope key bound by a prior / same-step `saveAs`. */
export function claimsToken(address: string, body: unknown, scope: Record<string, string>): unknown {
	if (!address.startsWith("$") && !address.includes(".") && scope[address] !== undefined) {
		return scope[address]
	}
	return readPath(body, address)
}
