/*
 * An identity no account can hold, for a sign-in oat sends without meaning to sign anyone in: a
 * failed login a throttle counts, or the contract floor's own call. Failed attempts against a real
 * address count toward that account's lockout, so neither ever names one.
 */

/* An email-shaped field: declared `format: email`, or named like one. */
function isEmail(name: string, schema: unknown): boolean {
	return (schema as { format?: unknown } | undefined)?.format === "email" || /e-?mail/i.test(name)
}

/**
 * The identity for the field `name`, whose schema is `schema`: `oat-nonexistent-<nonce>`, at RFC
 * 2606's reserved `.invalid` domain, which never resolves, where the field is an email.
 */
export function nonexistentIdentity(field: { name: string; schema: unknown }, nonce: string): string {
	const marked = `oat-nonexistent-${nonce}`
	return isEmail(field.name, field.schema) ? `${marked}@example.invalid` : marked
}
