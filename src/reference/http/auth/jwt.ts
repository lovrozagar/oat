/** HS256 JSON Web Tokens: signed with the server's secret, read back with whether the signature holds. */

import { createHmac, timingSafeEqual } from "node:crypto"

/** A token's claims, and whether its signature is the server's own over an HS256 header. */
export interface DecodedJwt {
	claims: Record<string, unknown>
	signed: boolean
}

/* `{"alg":"HS256","typ":"JWT"}`, base64url-encoded. */
const HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"

const mac = (secret: string, input: string): Buffer => createHmac("sha256", secret).update(input).digest()

/** The claims, signed with `secret` as an HS256 JWT. */
export function signJwt(secret: string, claims: Record<string, unknown>): string {
	const input = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`
	return `${input}.${mac(secret, input).toString("base64url")}`
}

/* A segment's JSON object, or `undefined` when it is not one. */
function objectOf(segment: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

/** A JWT's claims and whether `secret` signed it; `null` when the text is not a JWT at all. */
export function decodeJwt(secret: string, token: string): DecodedJwt | null {
	const parts = token.split(".")
	if (parts.length !== 3) return null
	const [header, payload, signature] = parts as [string, string, string]
	const head = objectOf(header)
	const claims = objectOf(payload)
	if (head === undefined || claims === undefined) return null
	const expected = mac(secret, `${header}.${payload}`)
	const given = Buffer.from(signature, "base64url")
	const signed = head.alg === "HS256" && given.length === expected.length && timingSafeEqual(given, expected)
	return { claims, signed }
}
