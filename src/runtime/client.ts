/** HTTP client with a full transcript, so every finding can cite the exchange that produced it. */

import type { HeaderRequest } from "../config/define-config.ts"
import { headerValue, MAX_429_RETRIES, retryWaitMs, type RateLimiter } from "./rate-limit.ts"

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
	/** Wall clock when the response finished, unix ms. */
	at: number
	/** Reconstructed HTTP/1.1 request size: start line, headers, body. */
	requestBytes: number
	/** Reconstructed HTTP/1.1 response size: start line, headers, body. */
	responseBytes: number
	/**
	 * `x-request-id` / `request-id` / `x-correlation-id` / `correlation-id`.
	 * Response header wins; otherwise what oat sent. Empty when neither side passed one.
	 */
	requestId: string
	/** Rate-limit category this request was paced against, when one matched. */
	rateLimitCategory?: string
	/** Where that category came from — a `spec.*` finding only ever cites a `"tag"` rejection. */
	rateLimitSource?: "tag" | "config" | "implicit"
	/** Whether the bucket had a token without waiting — oat believes it was under its own pace. */
	rateLimitHadRoom?: boolean
}

/** A principal bound so every dispatch can refresh and retry a 401 without call-site ceremony. */
export interface BoundAuth {
	matches: (headers: Record<string, string>) => boolean
	headers: () => Record<string, string>
	refreshIfStale: (force?: boolean) => Promise<void>
}

export interface RequestOptions {
	headers?: Record<string, string> | (() => Record<string, string>)
	query?: Record<string, string | number | undefined>
	/** Plain object (JSON), FormData, URLSearchParams, or any BodyInit. */
	body?: unknown
	/**
	 * Explicit type, or `null` when headers are already final.
	 * FormData never gets a Content-Type here — fetch must set the boundary.
	 */
	contentType?: string | null
	/**
	 * Countdown refresh before dispatch; a 401 forces one refresh + one retry.
	 * Prefer a getter for `headers` so the retry sends the live credential.
	 */
	refreshIfStale?: (force?: boolean) => Promise<void>
	/** Auth acquire / refresh hops must set this so they cannot recurse into refresh. */
	skipAuthRefresh?: boolean
	/** Named operation, when the caller knows it — `resolveHeaders` uses this to attach captcha. */
	operationId?: string
}

export class Client {
	readonly transcript: Exchange[] = []
	private seq = 0
	private inFlight = 0
	private readonly waiting: Array<() => void> = []
	private readonly boundAuth: BoundAuth[] = []

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

	private resolveHeaders: ((request: HeaderRequest) => Promise<Record<string, string> | null>) | undefined

	/** Per-request headers, merged after `globalHeaders` and before the principal's credential. */
	setResolveHeaders(fn: (request: HeaderRequest) => Promise<Record<string, string> | null>): void {
		this.resolveHeaders = fn
	}

	/** Register a principal so every request that carries its credential refreshes and 401-retries. */
	bindAuth(auth: BoundAuth): void {
		this.boundAuth.push(auth)
	}

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

		const resolveUserHeaders = (): Record<string, string> => {
			const raw = options.headers
			return { ...(typeof raw === "function" ? raw() : raw) }
		}

		const skip = options.skipAuthRefresh === true
		const matchAuth = (headers: Record<string, string>): BoundAuth | undefined =>
			skip ? undefined : this.boundAuth.find((auth) => auth.matches(headers))

		const refresh = skip ? undefined : (options.refreshIfStale ?? matchAuth(resolveUserHeaders())?.refreshIfStale)

		const dispatch = async (): Promise<Exchange> => {
			let userHeaders = resolveUserHeaders()
			const hookCtx: HeaderRequest = {
				method: method.toUpperCase(),
				url: url.toString(),
				...(options.operationId === undefined ? {} : { operationId: options.operationId }),
			}
			const hooked = this.resolveHeaders === undefined ? null : await this.resolveHeaders(hookCtx)
			const hookHeaders = hooked ?? {}
			const bound = matchAuth(userHeaders)
			/* globalHeaders → resolveHeaders → caller headers → auth credential. */
			if (bound !== undefined) userHeaders = { ...userHeaders, ...bound.headers() }
			const headers: Record<string, string> = { ...this.globalHeaders, ...hookHeaders, ...userHeaders }
			const encoded = encodeBody(options.body, options.contentType)
			if (encoded.contentType !== undefined) headers["content-type"] = encoded.contentType

			const init: RequestInit = { headers, method }
			if (encoded.init !== undefined) init.body = encoded.init

			/* Two independent constraints, both held: maxInFlight bounds in-flight HTTP with no
			 * notion of time, a rate-limit category bounds throughput over time. The in-flight
			 * slot is acquired first and released in the same finally as before — pacing sits
			 * entirely inside that window and never changes what maxInFlight itself guarantees. */
			const verb = method.toUpperCase()
			const tagged = this.rateLimiter?.resolve(verb, url.pathname)
			const implicit = tagged === undefined ? this.rateLimiter?.implicitRule(verb) : undefined
			const rule = tagged ?? implicit
			await this.acquire()
			let rateLimitHadRoom: boolean | undefined
			let started: number
			let response: Response
			let text: string
			let at = 0
			try {
				if (tagged !== undefined) rateLimitHadRoom = await this.rateLimiter?.acquire(tagged)
				else if (implicit !== undefined) rateLimitHadRoom = await this.rateLimiter?.waitImplicit(verb)
				started = performance.now()
				response = await fetch(url, init)
				text = await response.text()
				at = Date.now()
			} finally {
				this.release()
			}
			const contentType = response.headers.get("content-type") ?? ""
			let parsed: unknown = text
			if (!contentType.includes("text/event-stream")) {
				try {
					parsed = text === "" ? null : JSON.parse(text)
				} catch {
					/* keep the raw text — a non-JSON body is itself evidence */
				}
			}

			this.seq += 1
			const responseHeaders = Object.fromEntries(response.headers.entries())
			const exchange: Exchange = {
				at,
				durationMs: Math.round(performance.now() - started),
				method: verb,
				requestBody: options.body,
				requestBytes: requestMessageBytes(verb, url, headers, encoded.bytes, encoded.text),
				requestHeaders: headers,
				requestId: requestIdOf(headers, responseHeaders),
				responseBody: parsed,
				responseBytes: responseMessageBytes(response.status, response.statusText, responseHeaders, text),
				responseHeaders,
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

		if (refresh !== undefined) await refresh(false)
		let exchange = await dispatch()
		if (exchange.status === 401 && refresh !== undefined) {
			await refresh(true)
			exchange = await dispatch()
		}
		/* 429 is reactive: the first one is never a seed/check failure. Tags pace proactively;
		 * this path honours the server even when the op has no x-rate-limit at all. */
		for (let attempt = 0; exchange.status === 429 && attempt < MAX_429_RETRIES; attempt++) {
			const waitMs = retryWaitMs(headerValue(exchange.responseHeaders, "retry-after"), attempt)
			this.rateLimiter?.noteBackoff(method.toUpperCase(), url.pathname, waitMs)
			if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
			exchange = await dispatch()
			if (exchange.status === 401 && refresh !== undefined) {
				await refresh(true)
				exchange = await dispatch()
			}
		}
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
		for (const flag of curlBodyFlags(exchange.requestBody)) parts.push(flag)
	}
	return parts.join(" \\\n")
}

function curlBodyFlags(body: unknown): string[] {
	if (isFormData(body)) {
		const flags: string[] = []
		for (const [name, value] of body.entries()) {
			if (typeof value === "string") {
				flags.push(`  -F '${name}=${value.replace(/'/g, `'\\''`)}'`)
			} else {
				flags.push(`  -F '${name}=@${value.name};type=${value.type || "application/octet-stream"}'`)
			}
		}
		return flags
	}
	if (isURLSearchParams(body)) {
		return [`  --data-urlencode '${body.toString().replace(/'/g, `'\\''`)}'`]
	}
	if (typeof body === "string") {
		return [`  -d '${body.replace(/'/g, `'\\''`)}'`]
	}
	if (isRawBytes(body)) {
		return [`  --data-binary @-`]
	}
	return [`  -d '${JSON.stringify(body).replace(/'/g, `'\\''`)}'`]
}

type FetchBody = NonNullable<RequestInit["body"]>

interface EncodedInit {
	init?: FetchBody
	/** Set this header. `undefined` means do not touch Content-Type. */
	contentType?: string
	text?: string
	bytes: number
}

function encodeBody(body: unknown, contentType: string | null | undefined): EncodedInit {
	if (body === undefined) return { bytes: 0 }
	if (contentType === null) {
		const raw = asBodyInit(body)
		const encoded: EncodedInit = { bytes: bodyByteLength(body), init: raw ?? JSON.stringify(body) }
		if (typeof body === "string") encoded.text = body
		return encoded
	}
	if (isFormData(body)) {
		/* fetch sets multipart/form-data; boundary=… — setting it ourselves drops the boundary. */
		return { bytes: formDataBytes(body), init: body }
	}
	if (isURLSearchParams(body)) {
		const text = body.toString()
		return {
			bytes: utf8Bytes(text),
			contentType: contentType ?? "application/x-www-form-urlencoded",
			init: body,
			text,
		}
	}
	if (isRawBytes(body) || typeof body === "string") {
		const init = asBodyInit(body)
		const encoded: EncodedInit = { bytes: bodyByteLength(body), init: init ?? String(body) }
		if (contentType !== undefined) encoded.contentType = contentType
		if (typeof body === "string") encoded.text = body
		return encoded
	}
	const text = JSON.stringify(body)
	return {
		bytes: utf8Bytes(text),
		contentType: contentType ?? "application/json",
		init: text,
		text,
	}
}

function asBodyInit(body: unknown): FetchBody | undefined {
	if (typeof body === "string") return body
	if (isFormData(body) || isURLSearchParams(body) || isRawBytes(body)) return body as FetchBody
	if (typeof Blob !== "undefined" && body instanceof Blob) return body
	if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return body as FetchBody
	return undefined
}

function isFormData(body: unknown): body is FormData {
	return typeof FormData !== "undefined" && body instanceof FormData
}

function isURLSearchParams(body: unknown): body is URLSearchParams {
	return typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams
}

function isRawBytes(body: unknown): body is ArrayBuffer | ArrayBufferView | Blob {
	if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return true
	if (ArrayBuffer.isView(body)) return true
	if (typeof Blob !== "undefined" && body instanceof Blob) return true
	return false
}

function bodyByteLength(body: unknown): number {
	if (typeof body === "string") return utf8Bytes(body)
	if (isFormData(body)) return formDataBytes(body)
	if (isURLSearchParams(body)) return utf8Bytes(body.toString())
	if (typeof Blob !== "undefined" && body instanceof Blob) return body.size
	if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return body.byteLength
	if (ArrayBuffer.isView(body)) return body.byteLength
	return 0
}

function formDataBytes(form: FormData): number {
	let total = 0
	for (const [name, value] of form.entries()) {
		total += utf8Bytes(name) + 80
		if (typeof value === "string") total += utf8Bytes(value)
		else total += value.size + utf8Bytes(value.name)
	}
	return total
}

function utf8Bytes(text: string | undefined): number {
	return text === undefined || text === "" ? 0 : new TextEncoder().encode(text).byteLength
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const want = name.toLowerCase()
	return Object.keys(headers).some((key) => key.toLowerCase() === want)
}

/** Start line + headers + body. Host and Content-Length are filled when they would be on the wire. */
function requestMessageBytes(
	method: string,
	url: URL,
	headers: Record<string, string>,
	bodyBytes: number,
	body: string | undefined,
): number {
	const sent = { ...headers }
	if (!hasHeader(sent, "host")) sent.host = url.host
	if (bodyBytes > 0 && !hasHeader(sent, "content-length")) sent["content-length"] = String(bodyBytes)
	const start = `${method} ${url.pathname}${url.search} HTTP/1.1`
	if (body !== undefined) return httpMessageBytes(start, sent, body)
	let headerBytes = utf8Bytes(`${start}\r\n`)
	for (const [key, value] of Object.entries(sent)) headerBytes += utf8Bytes(`${key}: ${value}\r\n`)
	headerBytes += utf8Bytes(`\r\n`)
	return headerBytes + bodyBytes
}

function responseMessageBytes(
	status: number,
	statusText: string,
	headers: Record<string, string>,
	body: string,
): number {
	const sent = { ...headers }
	if (body !== "" && !hasHeader(sent, "content-length")) sent["content-length"] = String(utf8Bytes(body))
	const start = statusText === "" ? `HTTP/1.1 ${status}` : `HTTP/1.1 ${status} ${statusText}`
	return httpMessageBytes(start, sent, body)
}

function httpMessageBytes(startLine: string, headers: Record<string, string>, body: string | undefined): number {
	let text = `${startLine}\r\n`
	for (const [key, value] of Object.entries(headers)) {
		text += `${key}: ${value}\r\n`
	}
	text += `\r\n`
	if (body !== undefined) text += body
	return new TextEncoder().encode(text).byteLength
}

const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-correlation-id", "correlation-id"] as const

/** Response header first, then the request. Empty when neither side sent one of the known names. */
/** Plain snapshot of a request body for reports — FormData is not JSON. */
export function describeRequestBody(body: unknown): unknown {
	if (body === undefined) return undefined
	if (isFormData(body)) {
		const parts: Record<string, unknown> = {}
		for (const [name, value] of body.entries()) {
			if (typeof value === "string") parts[name] = value
			else parts[name] = { filename: value.name, mediaType: value.type, bytes: value.size }
		}
		return parts
	}
	if (isURLSearchParams(body)) return body.toString()
	if (isRawBytes(body)) return { bytes: bodyByteLength(body) }
	return body
}

export function requestIdOf(requestHeaders: Record<string, string>, responseHeaders: Record<string, string>): string {
	return headerOf(responseHeaders, REQUEST_ID_HEADERS) ?? headerOf(requestHeaders, REQUEST_ID_HEADERS) ?? ""
}

function headerOf(headers: Record<string, string>, names: readonly string[]): string | undefined {
	for (const name of names) {
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === name && value.trim() !== "") return value.trim()
		}
	}
	return undefined
}

/** Escapes the characters that stay special inside double quotes. */
function shellEscapeDouble(text: string): string {
	return text.replace(/(["\\`])/g, "\\$1")
}
