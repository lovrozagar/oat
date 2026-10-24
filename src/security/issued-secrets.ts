/**
 * Secrets a backend issues mid-run: a value it answers under a secret key (a TOTP setup's `secret`,
 * a fresh API key's `token`) is a credential wherever else it turns up, such as inside an otpauth URI
 * beside it, in a later request, or quoted in an error. They are found here in every form a record
 * may show them, so the redactor can scrub them as it scrubs the credentials a run places.
 */

import { isSecretJsonKey } from "./credential-names.ts"

/*
 * A credential, not a word: 16 characters or more whatever they are, since a base32 TOTP secret is
 * letters alone often enough (26/32 per character) to make a letters rule leak one; 12 to 15 only when
 * not letters alone, so `Bearer` under `token_type` and a short word under `password_hint` stay.
 */
function isCredential(value: string): boolean {
	if (value.length >= 16) return true
	return value.length >= 12 && !/^[A-Za-z]+$/.test(value)
}

/* A base32 secret as an otpauth URI carries it: uppercase, unspaced, unpadded. */
function base32Form(value: string): string | undefined {
	const compact = value.toUpperCase().replace(/[\s=-]/g, "")
	return compact !== value && /^[A-Z2-7]+$/.test(compact) ? compact : undefined
}

/** Every value `body` holds under a secret key that reads as a credential, raw and base32-normalized. */
export function issuedSecrets(body: unknown): string[] {
	const found = new Set<string>()
	const walk = (value: unknown, key: string | undefined): void => {
		if (typeof value === "string") {
			if (key === undefined || !isSecretJsonKey(key)) return
			const raw = value.trim()
			const normal = base32Form(raw)
			for (const form of [raw, normal]) if (form !== undefined && isCredential(form)) found.add(form)
			return
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item, key)
			return
		}
		if (value === null || typeof value !== "object") return
		for (const [child, nested] of Object.entries(value)) walk(nested, child)
	}
	walk(body, undefined)
	return [...found]
}
