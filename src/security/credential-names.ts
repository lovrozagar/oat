/*
 * The header names that carry a credential, whichever principal sent them. One list, read by the
 * redactor (never write one down in clear) and by redirect stripping (never send one to another
 * origin), so the two cannot disagree about what a credential is.
 */

/** Request headers that carry a credential by name. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"x-api-key",
	"api-key",
	"x-auth-token",
])

/* Also secret when written down: a response's cookies. A backend's own secret header is the config's
 * `redact.headers`, or matches the `x-…-key` family below. */
const REDACTED_HEADERS: ReadonlySet<string> = /* @__PURE__ */ new Set([...CREDENTIAL_HEADERS, "set-cookie"])

/** A header whose value is a secret wherever it is recorded: a known name, or `x-<anything>-key|secret|token`. */
export function isSecretHeaderName(name: string): boolean {
	const lower = name.toLowerCase()
	return REDACTED_HEADERS.has(lower) || /^x-.+-(key|secret|token)$/.test(lower)
}

/* Key families whose values are secret wherever they appear. */
const SECRET_KEY =
	/(^|[_-])(pass(word|wd)?|secret|token|api[_-]?key|apikey|credential|session[_-]?id|private[_-]?key|authorization|cookie)($|[_-])/i

/** A JSON key, form field or query parameter whose value is a secret: `refreshToken`, `api_key`, `password`. */
export function isSecretJsonKey(name: string): boolean {
	/* `refreshToken` and `refresh_token` are the same key: case boundaries count as separators. */
	return SECRET_KEY.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
}
