/**
 * One redactor for every place an exchange is written down: the journal, the markdown and JSON
 * reports, and the repro scripts.
 *
 * Three kinds of secret are caught. Headers by name — the usual ones, plus whatever header each
 * principal injects its credential under, registered as auth runs. JSON keys by family: anything
 * that reads as a token, secret, password, key or session. And credential *values* oat itself was
 * issued, wherever they turn up — echoed in a body, embedded in a URL, quoted in an error message.
 * Key names alone miss the last kind entirely.
 */

export const REDACTED = "<redacted>"

const HEADER_NAMES = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"api-key",
	"x-auth-token",
	"x-ia-tester-key",
])

/** Key families whose values are secret wherever they appear. */
const SECRET_KEY =
	/(^|[_-])(pass(word|wd)?|secret|token|api[_-]?key|apikey|credential|session[_-]?id|private[_-]?key|authorization|cookie)($|[_-])/i

const extraHeaders = new Set<string>()
const secrets = new Set<string>()

/** A header a principal injects its credential under: redacted from now on. */
export function registerSecretHeader(name: string): void {
	extraHeaders.add(name.toLowerCase())
}

/** A credential value oat was issued: scrubbed wherever it appears. Too-short values are ignored. */
export function registerSecret(value: string | undefined): void {
	if (value === undefined) return
	const trimmed = value.trim()
	if (trimmed.length < 6) return
	secrets.add(trimmed)
	/* A bearer token is also sent bare — register the token itself as well as the header value. */
	const bare = /^\w+\s+(\S{6,})$/.exec(trimmed)?.[1]
	if (bare !== undefined) secrets.add(bare)
}

export function isSecretHeaderName(name: string): boolean {
	const lower = name.toLowerCase()
	if (HEADER_NAMES.has(lower) || extraHeaders.has(lower)) return true
	return /^x-.+-(key|secret|token)$/i.test(lower)
}

export function isSecretJsonKey(name: string): boolean {
	/* `refreshToken` and `refresh_token` are the same key: case boundaries count as separators. */
	const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
	return SECRET_KEY.test(words)
}

/** `text` with every registered credential value replaced. */
export function redactText(text: string): string {
	let out = text
	for (const secret of secrets) {
		if (out.includes(secret)) out = out.split(secret).join(REDACTED)
	}
	return out
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers)) {
		out[key] = isSecretHeaderName(key) ? REDACTED : redactText(value)
	}
	return out
}

export function redactJson(value: unknown): unknown {
	if (typeof value === "string") return redactText(value)
	if (Array.isArray(value)) return value.map((item) => redactJson(item))
	if (value === null || typeof value !== "object") return value
	const out: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		out[key] = isSecretJsonKey(key) ? REDACTED : redactJson(child)
	}
	return out
}

/** A URL with registered credentials and secret-named query parameters removed. */
export function redactUrl(url: string): string {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return redactText(url)
	}
	for (const key of Array.from(parsed.searchParams.keys())) {
		if (isSecretJsonKey(key)) parsed.searchParams.set(key, REDACTED)
	}
	return redactText(parsed.toString())
}
