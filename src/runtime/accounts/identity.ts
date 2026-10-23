/**
 * What names an account: the values a sign-up sent under the fields people sign in and are found
 * by. The ledger keeps these and nothing else, so a password never reaches the run's folder.
 */

/* `address` too: the name `hooks.teardownPrincipal` has always removed an account by. */
const NAMES = /^(address|e-?mail(_?address)?|user_?name|login|handle|nick_?name|phone(_?number)?)$/i

/** The account-naming fields of a sign-up body, its top-level strings under such names. */
export function accountIdentity(body: unknown): Record<string, string> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return {}
	return Object.fromEntries(
		Object.entries(body).filter(
			(entry): entry is [string, string] => NAMES.test(entry[0]) && typeof entry[1] === "string" && entry[1] !== "",
		),
	)
}

/**
 * The top-level properties of a body schema that name an account. Generated, each carries the run's
 * nonce: two runs never send the same email, so neither reuses nor hides the other's account.
 */
export function identityNames(schema: unknown): string[] {
	if (schema === null || typeof schema !== "object") return []
	const properties = (schema as { properties?: unknown }).properties
	if (properties === null || typeof properties !== "object") return []
	return Object.keys(properties).filter((name) => NAMES.test(name))
}

/** One line a person can find the account by: its email, else its address, else its first naming value. */
export function accountLabel(identity: Readonly<Record<string, string>>): string | undefined {
	const email = Object.entries(identity).find(([key]) => /mail/i.test(key))?.[1]
	return email ?? identity["address"] ?? Object.values(identity)[0]
}
