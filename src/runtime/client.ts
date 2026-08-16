/** HTTP client with a full transcript, so every finding can cite the exchange that produced it. */

import type { RateLimiter } from "./rate-limit.ts"

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
	/** Rate-limit category this request was paced against, when one matched. */
	rateLimitCategory?: string
	/** Where that category came from — a `spec.*` finding only ever cites a `"tag"` rejection. */
	rateLimitSource?: "tag" | "config"
	/** Whether the bucket had a token without waiting — oat believes it was under its own pace. */
	rateLimitHadRoom?: boolean
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
	private inFlight = 0
	private readonly waiting: Array<() => void> = []

	constructor(
		private readonly baseUrl: string,
		private readonly globalHeaders: Record<string, string> = {},
		/**
		 * Requests allowed in flight at once.
		 *
		 * Parallelism past a server's comfort makes every request slower rather than the run
		 * faster — many APIs queue or throttle, so an unbounded burst trades wall-clock for
		 * nothing and risks tripping rate limits that then look like backend defects.
		 */
		private readonly maxInFlight = 4,
		private readonly onExchange?: (exchange: Exchange) => void,
		/** Paces requests per declared category. `undefined` when nothing is configured. */
		private readonly rateLimiter?: RateLimiter,
	) {}

	/** Admission control. Held for the duration of one request, released in a finally. */
	private async acquire(): Promise<void> {
		if (this.inFlight < this.maxInFlight) {
			this.inFlight += 1
			return
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve))
		this.inFlight += 1
	}

	private release(): void {
		this.inFlight -= 1
		this.waiting.shift()?.()
	}

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

		/* Two independent constraints, both held: maxInFlight bounds concurrency with no notion of
		 * time, a rate-limit category bounds throughput over time. The in-flight slot is acquired
		 * first and released in the same finally as before — pacing sits entirely inside that
		 * window and never changes what maxInFlight itself guarantees. */
		const rule = this.rateLimiter?.resolve(method.toUpperCase(), url.pathname)
		await this.acquire()
		let rateLimitHadRoom: boolean | undefined
		let started: number
		let response: Response
		let text: string
		try {
			if (rule !== undefined) rateLimitHadRoom = await this.rateLimiter?.acquire(rule)
			started = performance.now()
			response = await fetch(url, init)
			text = await response.text()
		} finally {
			this.release()
		}
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
			...(rule === undefined ? {} : { rateLimitCategory: rule.category, rateLimitSource: rule.source }),
			...(rateLimitHadRoom === undefined ? {} : { rateLimitHadRoom }),
		}
		this.transcript.push(exchange)
		this.onExchange?.(exchange)
		return exchange
	}

	get(path: string, options: RequestOptions = {}): Promise<Exchange> {
		return this.request("GET", path, options)
	}
}

export interface CurlOptions {
	/** Header names whose values are replaced by a shell variable reference. */
	redact?: readonly string[]
	/** Origin to replace with `"$BASE"`, so a script can be pointed at another environment. */
	origin?: string
}

/**
 * Reproducible `curl` for an exchange — the artifact backend teams actually use.
 *
 * Quoting matters here: anything holding a shell variable must be double-quoted or the script
 * silently runs against a literal `$BASE` with a literal `$TOKEN`. Everything else is
 * single-quoted so JSON bodies and query strings survive untouched.
 */
export function toCurl(exchange: Exchange, options: CurlOptions = {}): string {
	const redact = options.redact ?? ["authorization", "cookie", "x-api-key"]
	const url =
		options.origin !== undefined && exchange.url.startsWith(options.origin)
			? `"$BASE${shellEscapeDouble(exchange.url.slice(options.origin.length))}"`
			: `'${exchange.url}'`

	const parts = [`curl -i -X ${exchange.method} ${url}`]
	for (const [key, value] of Object.entries(exchange.requestHeaders)) {
		if (redact.includes(key.toLowerCase())) {
			/* Preserve the scheme prefix ("Bearer ", "ApiKey ") so the variable holds only the
			 * secret and the script stays copy-pasteable. */
			const scheme = /^(\w+)\s+/.exec(value)?.[1]
			const rendered = scheme === undefined ? "$TOKEN" : `${scheme} $TOKEN`
			parts.push(`  -H "${key}: ${rendered}"`)
			continue
		}
		parts.push(`  -H '${key}: ${value}'`)
	}
	if (exchange.requestBody !== undefined) {
		parts.push(`  -d '${JSON.stringify(exchange.requestBody).replace(/'/g, `'\\''`)}'`)
	}
	return parts.join(" \\\n")
}

/** Escapes the characters that stay special inside double quotes. */
function shellEscapeDouble(text: string): string {
	return text.replace(/(["\\`])/g, "\\$1")
}
