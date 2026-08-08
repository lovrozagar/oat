/** HTTP client with a full transcript, so every finding can cite the exchange that produced it. */

export interface Exchange {
	seq: number
	method: string
	url: string
	requestHeaders: Record<string, string>
	requestBody: unknown
	status: number
	responseHeaders: Record<string, string>
	responseBody: unknown
	durationMs: number
}

export interface RequestOptions {
	headers?: Record<string, string>
	query?: Record<string, string | number | undefined>
	body?: unknown
	/** Suppresses content-type on bodyless requests, and lets negative cases send a wrong one. */
	contentType?: string | null
}

export class Client {
	readonly transcript: Exchange[] = []
	private seq = 0

	constructor(
		private readonly baseUrl: string,
		private readonly globalHeaders: Record<string, string> = {},
	) {}

	async request(method: string, path: string, options: RequestOptions = {}): Promise<Exchange> {
		const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`)
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value))
		}

		const headers: Record<string, string> = { ...this.globalHeaders, ...options.headers }
		if (options.body !== undefined && options.contentType !== null) {
			headers["content-type"] = options.contentType ?? "application/json"
		}

		const init: RequestInit = { headers, method }
		if (options.body !== undefined) init.body = JSON.stringify(options.body)

		const started = performance.now()
		const response = await fetch(url, init)
		const text = await response.text()
		let parsed: unknown = text
		try {
			parsed = text === "" ? null : JSON.parse(text)
		} catch {
			/* keep the raw text — a non-JSON body is itself evidence */
		}

		this.seq += 1
		const exchange: Exchange = {
			durationMs: Math.round(performance.now() - started),
			method: method.toUpperCase(),
			requestBody: options.body,
			requestHeaders: headers,
			responseBody: parsed,
			responseHeaders: Object.fromEntries(response.headers.entries()),
			seq: this.seq,
			status: response.status,
			url: url.toString(),
		}
		this.transcript.push(exchange)
		return exchange
	}

	get(path: string, options: RequestOptions = {}): Promise<Exchange> {
		return this.request("GET", path, options)
	}
}

/** Reproducible `curl` for an exchange — the artifact backend teams actually use. */
export function toCurl(exchange: Exchange, redact: readonly string[] = ["authorization"]): string {
	const parts = [`curl -i -X ${exchange.method} '${exchange.url}'`]
	for (const [key, value] of Object.entries(exchange.requestHeaders)) {
		const shown = redact.includes(key.toLowerCase()) ? "$TOKEN" : value
		parts.push(`  -H '${key}: ${shown}'`)
	}
	if (exchange.requestBody !== undefined) {
		parts.push(`  -d '${JSON.stringify(exchange.requestBody)}'`)
	}
	return parts.join(" \\\n")
}
