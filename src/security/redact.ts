import { isSecretHeaderName, isSecretJsonKey } from "./credential-names.ts"

/*
 * One redactor per run, for every place an exchange is written down: the journal, the markdown and
 * JSON reports, and the repro scripts. Three kinds of secret are caught. Headers by name: the usual
 * ones, plus whatever header each principal injects its credential under. JSON keys by family:
 * anything that reads as a token, secret, password, key or session. And credential values the run
 * was issued, wherever they turn up: echoed in a body, embedded in a URL, quoted in an error.
 */

export const REDACTED = "<redacted>"

export class Redactor {
	readonly #headers = new Set<string>()
	readonly #secrets = new Set<string>()

	/** A header a principal injects its credential under: redacted from now on. */
	registerHeader(name: string): void {
		this.#headers.add(name.toLowerCase())
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

	/** `text` with every registered credential value replaced. */
	text(text: string): string {
		let out = text
		for (const secret of this.#secrets) {
			if (out.includes(secret)) out = out.split(secret).join(REDACTED)
		}
		return out
	}

	headers(headers: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {}
		for (const [key, value] of Object.entries(headers))
			out[key] = this.isSecretHeader(key) ? REDACTED : this.text(value)
		return out
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
		if (entries.some(([key]) => isSecretJsonKey(key))) {
			parsed.search = new URLSearchParams(
				entries.map(([key, value]): [string, string] => [key, isSecretJsonKey(key) ? REDACTED : value]),
			).toString()
		}
		return this.text(parsed.toString())
	}
}
