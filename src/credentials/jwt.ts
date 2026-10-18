/**
 * A JWT's claims, decoded without verifying the signature: oat reads its own credential to know
 * when it lapses and whose tenant it is, and makes no trust decision with it. Null when the value
 * is not a JWT, or its payload is not a JSON object.
 */
export function jwtClaims(value: string): Record<string, unknown> | null {
	const parts = value.split(".")
	if (parts.length !== 3) return null
	try {
		const claims: unknown = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"))
		return claims !== null && typeof claims === "object" && !Array.isArray(claims)
			? (claims as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}
