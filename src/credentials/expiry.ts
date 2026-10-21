import type { ExpiresIn } from "../config/types/security.ts"
import { jwtClaims } from "./jwt.ts"
import { readPath } from "../client/read-path.ts"

/** What a credential's lifetime is computed from. */
export interface ExpiryInput {
	/** The recipe's lifetime: seconds, or where the issuing answer states them. */
	expiresIn?: ExpiresIn | undefined
	/** The body of the answer that issued the value, a form answer's as its fields by name. */
	body: unknown
	value: string
	/** Epoch ms when the value was issued. */
	now: number
}

/**
 * When a credential lapses, in epoch ms: the lifetime the recipe or the issuing answer states, then
 * the JWT's `exp`, then null for a value that never lapses as far as oat can tell. Guessing a lifetime
 * too long makes requests fail mid-run for reasons that look like backend defects, so oat never guesses.
 */
export function expiresAtOf(input: ExpiryInput): number | null {
	const seconds = secondsOf(input)
	if (seconds !== undefined) return input.now + seconds * 1000
	const exp = jwtClaims(input.value)?.exp
	return typeof exp === "number" ? exp * 1000 : null
}

function secondsOf({ expiresIn, body }: ExpiryInput): number | undefined {
	if (typeof expiresIn === "number") return expiresIn
	if (expiresIn === undefined) return undefined
	const stated = readPath(body, expiresIn.from)
	const seconds = typeof stated === "string" && stated.trim() !== "" ? Number(stated) : stated
	return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : undefined
}
