import { isSecretHeaderName, isSecretJsonKey } from "./credential-names.ts"

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
		this.#secrets.add(trimmed)
		/* A bearer token is also sent bare: register the token itself as well as the header value. */
		const bare = /^\w+\s+(\S{6,})$/.exec(trimmed)?.[1]
		if (bare !== undefined) this.#secrets.add(bare)
	}

	isSecretHeader(name: string): boolean {
		return isSecretHeaderName(name) || this.#headers.has(name.toLowerCase())
	}

	/** `text` with every registered credential value, and every registered cookie's value, replaced. */
	text(text: string): string {
		let out = text
		for (const secret of this.#secrets) {
			if (out.includes(secret)) out = out.split(secret).join(REDACTED)
		}
		for (const pair of this.#cookies.values()) out = out.replace(pair, `$1$2=${REDACTED}`)
		return out
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

	json(value: unknown): unknown {
		if (typeof value === "string") return this.text(value)
		if (Array.isArray(value)) return value.map((item) => this.json(item))
		if (value === null || typeof value !== "object") return value
		const out: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) out[key] = isSecretJsonKey(key) ? REDACTED : this.json(child)
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

	#isSecretParam(name: string): boolean {
		return isSecretJsonKey(name) || this.#query.has(name)
	}
}
