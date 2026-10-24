import { isSecretHeaderName, isSecretJsonKey } from "./credential-names.ts"
import { issuedSecrets } from "./issued-secrets.ts"

/*
 * One redactor per run, for every place an exchange is written down: the journal, the markdown and
 * JSON reports, and the repro scripts. Three kinds of secret are caught. Headers by name: the usual
 * ones, plus whatever header each principal injects its credential under. JSON keys by family:
 * anything that reads as a token, secret, password, key or session. And credential values the run
 * was issued, wherever they turn up: echoed in a body, embedded in a URL, quoted in an error.
 * Every credential a run places registers its header, query and cookie names and its values here,
 * so whatever the document calls them, they never print. An Authorization header keeps its scheme
 * word (`Bearer`, `ApiKey`), which says what was sent without saying the secret.
 */

export const REDACTED = "<redacted>"

/** What one placed credential sends, by name, and the values a redactor must never print. */
export interface PlacedSecrets {
	headers: readonly string[]
	query: readonly string[]
	cookies: readonly string[]
	values: readonly string[]
}

/* Headers whose value is `<scheme> <credential>`, so the scheme word is no secret. */
const SCHEMED_HEADERS: ReadonlySet<string> = /* @__PURE__ */ new Set(["authorization", "proxy-authorization"])

/*
 * An otpauth URI's `secret` parameter, raw and percent-encoded (inside another URL, as a QR service
 * takes it): a TOTP seed by its scheme alone, whether or not a key beside it named it.
 */
const OTPAUTH_SECRET = /(otpauth:\/\/[^\s"'<>?]*\?(?:[^\s"'<>#]*?&)?secret=)[^&#\s"'<>]*/gi
const OTPAUTH_SECRET_ENCODED = /(otpauth%3A%2F%2F[^\s"'<>&]*?secret%3D)[^&#%\s"'<>]*/gi

/* `application/x-www-form-urlencoded`, with or without parameters. */
const FORM_MEDIA_TYPE = /^\s*application\/x-www-form-urlencoded\s*(;|$)/i

/* A form-encoded name or value as text; a malformed escape is kept as it was sent. */
function formDecoded(raw: string): string {
	try {
		return decodeURIComponent(raw.replaceAll("+", " "))
	} catch {
		return raw
	}
}

/* `value` percent-encoded, RFC 3986 strict and loose, and form-encoded; none for a lone surrogate. */
function urlForms(value: string): string[] {
	let percent: string
	try {
		percent = encodeURIComponent(value)
	} catch {
		return []
	}
	const strict = percent.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
	return [percent, strict, new URLSearchParams([["", value]]).toString().slice(1)]
}

export class Redactor {
	readonly #headers = new Set<string>()
	readonly #secrets = new Set<string>()
	readonly #query = new Set<string>()
	/* A registered cookie's `name=value` pair, by name. */
	readonly #cookies = new Map<string, RegExp>()

	/** A header a principal injects its credential under: redacted from now on. */
	registerHeader(name: string): void {
		this.#headers.add(name.toLowerCase())
	}

	/** A query parameter a credential is placed in: its value is redacted from every URL, whatever it is. */
	registerQuery(name: string): void {
		this.#query.add(name)
	}

	/** A cookie a credential is placed in: its value is redacted from every `name=value` pair. */
	registerCookie(name: string): void {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		this.#cookies.set(name, new RegExp(`(^|[;,\\s])(${escaped})=[^;,\\s]*`, "g"))
	}

	/** Every name and value one placed credential sends. */
	registerPlacement(secrets: PlacedSecrets): void {
		for (const name of secrets.headers) this.registerHeader(name)
		for (const name of secrets.query) this.registerQuery(name)
		for (const name of secrets.cookies) this.registerCookie(name)
		for (const value of secrets.values) this.registerSecret(value)
	}

	/** A credential value the run was issued: scrubbed wherever it appears. Too-short values are ignored. */
	registerSecret(value: string | undefined): void {
		const trimmed = value?.trim() ?? ""
		if (trimmed.length < 6) return
		this.#addSecret(trimmed)
		/* A bearer token is also sent bare: register the token itself as well as the header value. */
		const bare = /^\w+\s+(\S{6,})$/.exec(trimmed)?.[1]
		if (bare !== undefined) this.#addSecret(bare)
	}

	/**
	 * Secrets a backend issued in a response `body`, under a secret key: scrubbed from now on wherever
	 * they appear, in this record and every later one, and never sent elsewhere (`holdsSecret`). Only a
	 * response is learned from: a request carries values the run made, such as a generated password.
	 */
	learn(body: unknown): void {
		for (const value of issuedSecrets(body)) this.#addSecret(value)
	}

	/* A value as issued and as a URL or a form writes it: a base64 token's `+/=` reach the wire encoded. */
	#addSecret(value: string): void {
		for (const written of [value, ...urlForms(value)]) this.#secrets.add(written)
	}

	/** Whether `value` carries a registered credential value, whole or inside it: never one to send elsewhere. */
	holdsSecret(value: string): boolean {
		for (const secret of this.#secrets) if (value.includes(secret)) return true
		return false
	}

	isSecretHeader(name: string): boolean {
		return isSecretHeaderName(name) || this.#headers.has(name.toLowerCase())
	}

	/** `text` with every registered credential value, every registered cookie's value and every otpauth secret replaced. */
	text(text: string): string {
		let out = text
		for (const secret of this.#secrets) {
			if (out.includes(secret)) out = out.split(secret).join(REDACTED)
		}
		for (const pair of this.#cookies.values()) out = out.replace(pair, `$1$2=${REDACTED}`)
		return out.replace(OTPAUTH_SECRET, `$1${REDACTED}`).replace(OTPAUTH_SECRET_ENCODED, `$1${REDACTED}`)
	}

	/** A recorded body as it may be written down: text by its media type, anything else as JSON. */
	body(value: unknown, mediaType: string): unknown {
		return typeof value === "string" ? this.textBody(value, mediaType) : this.json(value)
	}

	/**
	 * A body that is text, by its media type: a form's fields as `field` redacts them, any other text
	 * scrubbed of registered values. A token endpoint may answer its pair as a form.
	 */
	textBody(text: string, mediaType: string): string {
		if (!FORM_MEDIA_TYPE.test(mediaType)) return this.text(text)
		return text
			.split("&")
			.map((pair) => this.#formPair(pair))
			.join("&")
	}

	headers(headers: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {}
		for (const [key, value] of Object.entries(headers)) out[key] = this.#headerValue(key, value)
		return out
	}

	/** A form field or urlencoded parameter: redacted when its name is a secret's, scrubbed otherwise. */
	field(name: string, value: string): string {
		return this.#isSecretParam(name) ? REDACTED : this.text(value)
	}

	/** `value` with secret keys redacted and every registered or issued value scrubbed, wherever it sits. */
	json(value: unknown): unknown {
		return this.#json(value)
	}

	#json(value: unknown): unknown {
		if (typeof value === "string") return this.text(value)
		if (Array.isArray(value)) return value.map((item) => this.#json(item))
		if (value === null || typeof value !== "object") return value
		const out: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) out[key] = isSecretJsonKey(key) ? REDACTED : this.#json(child)
		return out
	}

	/** A URL with registered credentials and secret-named query parameters removed. */
	url(url: string): string {
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			return this.text(url)
		}
		const entries = Array.from(parsed.searchParams)
		/* Every occurrence, in place: a repeated parameter stays repeated, so the URL keeps its shape. */
		if (entries.some(([key]) => this.#isSecretParam(key))) {
			parsed.search = new URLSearchParams(
				entries.map(([key, value]): [string, string] => [key, this.#isSecretParam(key) ? REDACTED : value]),
			).toString()
		}
		return this.text(parsed.toString())
	}

	#headerValue(name: string, value: string): string {
		if (!this.isSecretHeader(name)) return this.text(value)
		const scheme = SCHEMED_HEADERS.has(name.toLowerCase()) ? /^([A-Za-z][\w.-]*)\s+\S/.exec(value)?.[1] : undefined
		return scheme === undefined ? REDACTED : `${scheme} ${REDACTED}`
	}

	/* One `name=value` pair, its value redacted as a field; a pair redaction leaves alone keeps its encoding. */
	#formPair(pair: string): string {
		const at = pair.indexOf("=")
		if (at === -1) return this.text(pair)
		const name = pair.slice(0, at)
		const value = formDecoded(pair.slice(at + 1))
		const redacted = this.field(formDecoded(name), value)
		return redacted === value ? pair : `${name}=${redacted}`
	}

	#isSecretParam(name: string): boolean {
		return isSecretJsonKey(name) || this.#query.has(name)
	}
}
