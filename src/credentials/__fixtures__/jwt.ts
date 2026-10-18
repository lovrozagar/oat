/** An unsigned JWT carrying these claims. */
export function jwtOf(claims: Record<string, unknown>): string {
	return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
}
