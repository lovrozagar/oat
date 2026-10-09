/** HTTP client with a full transcript, so every finding can cite the exchange that produced it. */

import type { HeaderRequest } from "../config/define-config.ts"
import {
	CREDENTIAL_HEADERS,
	CookieJar,
	MAX_REDIRECTS,
	applyJarToHeaders,
	isAbsoluteHttpUrl,
	isRedirectStatus,
	omitHeader,
	recordResponseHeaders,
	redirectTarget,
	setCookieHeadersFrom,
	type RedirectHop,
} from "./cookies.ts"
import { headerValue, MAX_429_RETRIES, retryWaitMs, type RateLimiter } from "./rate-limit.ts"
import {
	DEFAULT_NETWORK_RETRIES,
	NetworkError,
	classifyNetworkError,
	describeNetworkKind,
	hasUsableInterface,
	isNetworkError,
	networkRetryWaitMs,
	refineNetworkKind,
	type NetworkKind,
} from "./network.ts"
import { sleep } from "./poll.ts"
import { REDACTED, isSecretHeaderName, isSecretJsonKey, redactJson, redactText, redactUrl } from "./redact.ts"
import { BodySpool, isBodyRef, isFormSnapshot, readResponsePayload, releaseTranscriptBodies } from "./transcript.ts"

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
	/** Size and hash of a large response body as received; what a stored reference names. */
	responseDigest?: { bytes: number; sha256: string }
	/** Named operation, when the caller passed one. */
	operationId?: string
	/** `uploads.each` filename, when this request is one cell of that matrix. */
	fixture?: string
	/** Set when `fetch` threw — there was no HTTP status. */
	network?: { kind: NetworkKind; attempt: number; message: string }
	/**
	 * Intermediate 3xx hops when this request followed redirects with a cookie jar.
	 * The exchange itself is the original URL + the final status/headers/body.
	 */
	redirects?: RedirectHop[]
	/** Landing URL when a followed redirect chain ended somewhere other than `url`. */
	finalUrl?: string
	/** Cookie jar after this hop (this response + followed hops). */
	cookies?: Record<string, string>
	/** The documented path template this request resolved to, e.g. `/v1/tables/{table_id}`. */
	template?: string
	/** The principal whose credential the request carried, when one did. */
	principal?: string
	/** Why oat sent it — see `Purpose`. */
	purpose?: Purpose
	/** The check that issued it, when a check did. */
	check?: string
	/** The entity under test when it was issued. */
	subject?: string
	/**
	 * Set when this response was answered again: a 401 refreshed and retried, or a 429 waited out.
	 * Only the final answer is the backend's verdict on the request.
	 */
	superseded?: true
}

/**
 * Why an exchange happened. Normal traffic — seeding, a check's assertions, auth, teardown — is
 * what the document has to describe. A deliberate negative probe is oat sending something it
 * expects to be refused, and what a backend answers it with is judged separately.
 */
export type Purpose = "seed" | "assertion" | "probe" | "auth" | "teardown"

/** Who is asking, and why: carried onto every exchange a view sends. */
/** Methods that cannot change server state. */
export type SafeMethod = "GET" | "HEAD" | "OPTIONS"

const SAFE_METHODS = new Set<string>(["GET", "HEAD", "OPTIONS"])

/** A client that can only read: what a check that does not mutate receives. */
export interface ReadClient extends Omit<Client, "request" | "view"> {
	request(method: SafeMethod, path: string, options?: RequestOptions): Promise<Exchange>
	view(context: ExchangeContext): ReadClient
}

export interface ExchangeContext {
	check?: string
	subject?: string
	purpose?: Purpose
}

/** Maps a request to the documented operation it is an instance of. */
export type OperationResolver = (
	method: string,
	relativePath: string,
) => { operationId: string; template: string; entity?: string | null } | null

/** A principal bound so every dispatch can refresh and retry a 401 without call-site ceremony. */
export interface BoundAuth {
	matches: (headers: Record<string, string>) => boolean
	headers: () => Record<string, string>
	refreshIfStale: (force?: boolean) => Promise<void>
}

/** Fired around `fetch` — start is on the wire, end is return or throw. */
export interface RequestStart {
	method: string
	url: string
	at: number
	requestId: string
	requestBytes: number
}

export interface HttpHooks {
	start?: (probe: RequestStart) => void
	end?: (probe: RequestStart) => void
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
	/** Who is asking and why. A view fills this in; a caller may narrow `purpose` per request. */
	context?: ExchangeContext
	/** Named operation, when the caller knows it — `resolveHeaders` uses this to attach captcha. */
	operationId?: string
	/** `uploads.each` filename, recorded on the exchange for the journal. */
	fixture?: string
	/**
	 * `follow` (jar) keeps intermediate `Set-Cookie` visible to `saveAs`.
	 * `manual` returns the first 3xx. Unset: native fetch follow, no jar.
	 */
	redirect?: "follow" | "manual"
}

/** Refreshing a principal's credential failed; `principal` names it when known. */
export class AuthRefreshError extends Error {
	constructor(
		readonly principal: string | undefined,
		readonly reason: unknown,
	) {
		super(
			`refreshing the credential${principal === undefined ? "" : ` of "${principal}"`} failed: ` +
				(reason instanceof Error ? reason.message : String(reason)),
		)
		this.name = "AuthRefreshError"
	}
}

/** Failures that prove the request never reached the server. */
const NEVER_SENT: ReadonlySet<NetworkKind> = new Set(["offline", "dns", "refused", "unreachable"])
const IDEMPOTENT: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])
/** How long one request may take across every attempt and wait, unless configured. */
export const DEFAULT_DEADLINE_MS = 10 * 60_000

/** Optional retry / wait-for-link policy. Unset keeps today's "throw and hope". */
export interface NetworkClientOptions {
	retries?: number
	requestTimeoutMs?: number
	/** Total time one request may take across every attempt and wait. */
	deadlineMs?: number
	awaitRecovery?: (error: NetworkError) => Promise<boolean>
}

export class Client {
	/**
	 * Every exchange, with bodies compacted for memory. The exchange a request returns to its
	 * caller is never compacted: it holds the real body, however large.
	 */
	readonly transcript: Exchange[] = []
	private readonly byOperationId = new Map<string, Exchange[]>()
	private readonly byEntity = new Map<string, Exchange[]>()
	private readonly entityOf = new Map<number, string>()
	private operationResolver: OperationResolver | undefined
	private principalResolver: ((headers: Record<string, string>) => string | undefined) | undefined
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
		private readonly onExchange?: (exchange: Exchange) => void | Promise<void>,
		/** Paces requests per declared category. `undefined` when nothing is configured. */
		private readonly rateLimiter?: RateLimiter,
		/** Observes each dispatch. `start` runs just before `fetch`; `end` always follows. */
		private readonly httpHooks?: HttpHooks,
		private readonly network?: NetworkClientOptions,
	) {}

	private resolveHeaders: ((request: HeaderRequest) => Promise<Record<string, string> | null>) | undefined

	/** Per-request headers, merged after `globalHeaders` and before the principal's credential. */
	setResolveHeaders(fn: (request: HeaderRequest) => Promise<Record<string, string> | null>): void {
		this.resolveHeaders = fn
	}

	/** Resolves each request to its documented operation, so nothing downstream parses URLs. */
	setOperationResolver(resolve: OperationResolver): void {
		this.operationResolver = resolve
	}

	/** Names the principal a set of request headers belongs to. */
	setPrincipalResolver(resolve: (headers: Record<string, string>) => string | undefined): void {
		this.principalResolver = resolve
	}

	/** The path below the base URL — what a documented path template describes. */
	relativePath(url: URL | string): string {
		const pathname = typeof url === "string" ? new URL(url).pathname : url.pathname
		const base = new URL(this.baseUrl).pathname.replace(/\/$/, "")
		return base !== "" && pathname.startsWith(base) ? pathname.slice(base.length) || "/" : pathname
	}

	/** Exchanges that resolved to an operation of `entity`, in order. */
	exchangesForEntity(entity: string): readonly Exchange[] {
		return this.byEntity.get(entity) ?? []
	}

	/** Exchanges that resolved to `operationId`, in order. */
	exchangesFor(operationId: string): readonly Exchange[] {
		return this.byOperationId.get(operationId) ?? []
	}

	/**
	 * A client that stamps every request it sends with `context`. Checks each get their own, so
	 * an exchange names the check that issued it even while checks run concurrently.
	 */
	view(context: ExchangeContext, readOnly = false): Client {
		const request = (method: string, path: string, options: RequestOptions = {}): Promise<Exchange> => {
			/* The type already forbids it; this catches a cast or an untyped caller. */
			if (readOnly && !SAFE_METHODS.has(method.toUpperCase())) {
				return Promise.reject(
					new Error(`check "${context.check ?? "?"}" does not mutate, but sent ${method.toUpperCase()} ${path}`),
				)
			}
			return this.request(method, path, { ...options, context: { ...context, ...options.context } })
		}
		const view = (more: ExchangeContext): Client => this.view({ ...context, ...more }, readOnly)
		return new Proxy(this, {
			get(target, property, receiver) {
				if (property === "request") return request
				/* Through the receiver, so a proxy wrapped around this view still sees the request. */
				if (property === "get") {
					return (path: string, options: RequestOptions = {}) => (receiver as Client).request("GET", path, options)
				}
				if (property === "view") return view
				return Reflect.get(target, property, receiver)
			},
		})
	}

	/** A view that refuses any request that could change server state. */
	readOnlyView(context: ExchangeContext): ReadClient {
		return this.view(context, true)
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
		if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") this.writes += 1
		const url = new URL(isAbsoluteHttpUrl(path) ? path : `${this.baseUrl}${path}`)
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value))
		}
		let pendingEntity: string | undefined
		const resolved = isAbsoluteHttpUrl(path)
			? null
			: (this.operationResolver?.(method.toUpperCase(), this.relativePath(url)) ?? null)
		const stamp = (headers: Record<string, string>): Partial<Exchange> => {
			if (resolved?.entity !== undefined && resolved.entity !== null) pendingEntity = resolved.entity
			const operationId = options.operationId ?? resolved?.operationId
			const principal = this.principalResolver?.(headers)
			const context = options.context ?? {}
			return {
				...(operationId === undefined ? {} : { operationId }),
				...(resolved === null ? {} : { template: resolved.template }),
				...(principal === undefined ? {} : { principal }),
				...(context.purpose === undefined ? {} : { purpose: context.purpose }),
				...(context.check === undefined ? {} : { check: context.check }),
				...(context.subject === undefined ? {} : { subject: context.subject }),
			}
		}

		const resolveUserHeaders = (): Record<string, string> => {
			const raw = options.headers
			return { ...(typeof raw === "function" ? raw() : raw) }
		}

		const skip = options.skipAuthRefresh === true
		const matchAuth = (headers: Record<string, string>): BoundAuth | undefined =>
			skip ? undefined : this.boundAuth.find((auth) => auth.matches(headers))

		const refresh = skip ? undefined : (options.refreshIfStale ?? matchAuth(resolveUserHeaders())?.refreshIfStale)

		const dispatch = async (attempt = 0): Promise<Exchange> => {
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

			const jar = new CookieJar()
			const callerCookie = headerValue(headers, "cookie")
			/* Every header that carries a credential: the known names, and whatever the bound
			 * principal injects — an API key under a custom name is still a key. */
			const credentialNames = new Set([
				...CREDENTIAL_HEADERS,
				...Object.keys(bound?.headers() ?? {}).map((name) => name.toLowerCase()),
			])
			const hops: RedirectHop[] = []
			let hopUrl = url
			let hopMethod = method
			let hopBody: RequestInit["body"] = encoded.init
			const hopHeaders: Record<string, string> = { ...headers }
			const init: RequestInit = { headers: hopHeaders, method: hopMethod }
			if (hopBody !== undefined) init.body = hopBody
			if (options.redirect !== undefined) init.redirect = "manual"

			/* Two independent constraints, both held: maxInFlight bounds in-flight HTTP with no
			 * notion of time, a rate-limit category bounds throughput over time. The in-flight
			 * slot is acquired first and released in the same finally as before — pacing sits
			 * entirely inside that window and never changes what maxInFlight itself guarantees. */
			const verb = method.toUpperCase()
			/* Rules are written against documented paths, which never include the base path. */
			const tagged = this.rateLimiter?.resolve(
				verb,
				this.relativePath(url),
				options.operationId ?? resolved?.operationId,
			)
			const implicit = tagged === undefined ? this.rateLimiter?.implicitRule(verb) : undefined
			const rule = tagged ?? implicit
			await this.acquire()
			let rateLimitHadRoom: boolean | undefined
			let started: number
			let response: Response
			let parsed: unknown = null
			let bodyBytes = 0
			let digest: { bytes: number; sha256: string } | undefined
			let at = 0
			try {
				if (tagged !== undefined) rateLimitHadRoom = await this.rateLimiter?.acquire(tagged)
				else if (implicit !== undefined) rateLimitHadRoom = await this.rateLimiter?.waitImplicit(verb)
				const probe: RequestStart = {
					at: Date.now(),
					method: verb,
					requestBytes: requestMessageBytes(verb, url, headers, encoded.bytes, encoded.text),
					requestId: requestIdOf(headers, {}),
					url: url.toString(),
				}
				this.httpHooks?.start?.(probe)
				started = performance.now()
				try {
					const timeoutMs = this.network?.requestTimeoutMs
					const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
					const once = async (target: URL, hopInit: RequestInit): Promise<Response> =>
						fetch(target, signal === undefined ? hopInit : { ...hopInit, signal })
					applyJarToHeaders(hopHeaders, jar, hopUrl, callerCookie)
					response = await once(hopUrl, { ...init, headers: hopHeaders, method: hopMethod })
					;({ parsed, bodyBytes, digest } = await readResponsePayload(response))
					jar.absorb(hopUrl, setCookieHeadersFrom(response.headers))
					if (options.redirect === "follow") {
						while (isRedirectStatus(response.status) && hops.length < MAX_REDIRECTS) {
							const next = redirectTarget(response.status, hopMethod, response.headers.get("location"), hopUrl)
							if (next === null) break
							hops.push({
								responseHeaders: recordResponseHeaders(response.headers),
								status: response.status,
								url: hopUrl.toString(),
							})
							/* Another origin — scheme, host or port — gets no credential of ours. */
							const crossOrigin = next.url.origin !== url.origin
							if (crossOrigin) {
								for (const name of Object.keys(hopHeaders)) {
									if (credentialNames.has(name.toLowerCase())) delete hopHeaders[name]
								}
							}
							hopUrl = next.url
							hopMethod = next.method
							if (next.dropBody) {
								hopBody = undefined
								omitHeader(hopHeaders, "content-type")
								omitHeader(hopHeaders, "content-length")
							}
							applyJarToHeaders(hopHeaders, jar, hopUrl, crossOrigin ? undefined : callerCookie)
							const nextInit: RequestInit = {
								headers: hopHeaders,
								method: hopMethod,
								redirect: "manual",
							}
							if (hopBody !== undefined) nextInit.body = hopBody
							response = await once(hopUrl, nextInit)
							;({ parsed, bodyBytes, digest } = await readResponsePayload(response))
							jar.absorb(hopUrl, setCookieHeadersFrom(response.headers))
						}
					}
					at = Date.now()
				} catch (error) {
					const raw = classifyNetworkError(error)
					const kind = raw === null ? (hasUsableInterface() ? null : "offline") : refineNetworkKind(raw)
					if (kind === null) throw error
					const message = `${verb} ${url.toString()} failed (${kind}: ${describeNetworkKind(kind)})`
					this.seq += 1
					const failed: Exchange = {
						at: Date.now(),
						durationMs: Math.round(performance.now() - started),
						method: verb,
						network: { attempt, kind, message },
						requestBody: options.body,
						requestBytes: probe.requestBytes,
						requestHeaders: headers,
						requestId: probe.requestId,
						responseBody: { error: "network", kind, message },
						responseBytes: 0,
						responseHeaders: {},
						seq: this.seq,
						status: 0,
						url: url.toString(),
						...stamp(headers),
						...(options.fixture === undefined ? {} : { fixture: options.fixture }),
					}
					await this.onExchange?.(failed)
					await this.record(failed, pendingEntity)
					throw new NetworkError({
						attempts: attempt + 1,
						cause: error,
						kind,
						message,
						method: verb,
						url: url.toString(),
					})
				} finally {
					this.httpHooks?.end?.(probe)
				}
			} finally {
				this.release()
			}
			this.seq += 1
			const responseHeaders = recordResponseHeaders(response.headers)
			const cookies = jar.snapshot()
			const landing = hopUrl.toString()
			const exchange: Exchange = {
				at,
				durationMs: Math.round(performance.now() - started),
				method: verb,
				requestBody: options.body,
				requestBytes: requestMessageBytes(verb, url, headers, encoded.bytes, encoded.text),
				requestHeaders: headers,
				requestId: requestIdOf(headers, responseHeaders),
				responseBody: parsed,
				responseBytes: responseMessageBytes(response.status, response.statusText, responseHeaders, bodyBytes),
				responseHeaders,
				...(digest === undefined ? {} : { responseDigest: digest }),
				seq: this.seq,
				status: response.status,
				url: url.toString(),
				...(rule === undefined ? {} : { rateLimitCategory: rule.category, rateLimitSource: rule.source }),
				...(rateLimitHadRoom === undefined ? {} : { rateLimitHadRoom }),
				...stamp(headers),
				...(options.fixture === undefined ? {} : { fixture: options.fixture }),
				...(hops.length === 0 ? {} : { redirects: hops }),
				...(landing === url.toString() ? {} : { finalUrl: landing }),
				...(Object.keys(cookies).length === 0 ? {} : { cookies }),
			}
			await this.onExchange?.(exchange)
			await this.record(exchange, pendingEntity)
			/* What the backend said is evidence: no check may rewrite it after the fact. */
			return Object.freeze(exchange)
		}

		/*
		 * A failed request may be sent again only when doing so cannot do something twice: it never
		 * left this machine, or the method is idempotent, or it carries an idempotency key. A POST
		 * that timed out may well have created its record — resending it creates a second one, and
		 * oat would then report the duplicate as the backend's.
		 */
		const repeatable = (error: NetworkError): boolean =>
			NEVER_SENT.has(error.kind) ||
			IDEMPOTENT.has(method.toUpperCase()) ||
			Object.keys(resolveUserHeaders()).some((name) => /idempotency[-_]?key/i.test(name))
		const deadline = performance.now() + (this.network?.deadlineMs ?? DEFAULT_DEADLINE_MS)
		/* A refresh that fails is the backend's failure to keep a session alive, not this request's.
		 * It is raised as its own error so the run reports it rather than losing it in a check. */
		const refreshing = async (force: boolean): Promise<void> => {
			try {
				await refresh?.(force)
			} catch (error) {
				throw new AuthRefreshError(this.principalResolver?.(resolveUserHeaders()), error)
			}
		}
		const resilient = async (): Promise<Exchange> => {
			const retries = this.network === undefined ? 0 : Math.max(0, this.network.retries ?? DEFAULT_NETWORK_RETRIES)
			let last: NetworkError | undefined
			for (let attempt = 0; attempt <= retries; attempt++) {
				try {
					return await dispatch(attempt)
				} catch (error) {
					if (!isNetworkError(error)) throw error
					last = error
					if (!repeatable(error)) throw error
					const wait = networkRetryWaitMs(attempt)
					if (performance.now() + wait > deadline) throw error
					if (attempt < retries) await sleep(wait)
				}
			}
			if (
				last !== undefined &&
				repeatable(last) &&
				performance.now() < deadline &&
				this.network?.awaitRecovery !== undefined &&
				(await this.network.awaitRecovery(last))
			) {
				return dispatch(retries + 1)
			}
			throw last as NetworkError
		}

		if (refresh !== undefined) await refreshing(false)
		let exchange = await resilient()
		if (exchange.status === 401 && refresh !== undefined) {
			this.supersede(exchange)
			await refreshing(true)
			exchange = await resilient()
		}
		/* 429 is reactive: the first one is never a seed/check failure. Tags pace proactively;
		 * this path honours the server even when the op has no x-rate-limit at all. */
		for (let attempt = 0; exchange.status === 429 && attempt < MAX_429_RETRIES; attempt++) {
			const waitMs = retryWaitMs(headerValue(exchange.responseHeaders, "retry-after"), attempt)
			this.rateLimiter?.noteBackoff(
				method.toUpperCase(),
				this.relativePath(url),
				waitMs,
				options.operationId ?? resolved?.operationId,
			)
			if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
			this.supersede(exchange)
			exchange = await resilient()
			if (exchange.status === 401 && refresh !== undefined) {
				this.supersede(exchange)
				await refreshing(true)
				exchange = await resilient()
			}
		}
		return exchange
	}

	get(path: string, options: RequestOptions = {}): Promise<Exchange> {
		return this.request("GET", path, options)
	}

	/**
	 * Keeps a compacted copy in the transcript. The caller's exchange is left whole: a check
	 * reading a 300 KiB page must see the page, not a hash of it.
	 */
	private async record(exchange: Exchange, entity?: string): Promise<void> {
		const stored: Exchange = { ...exchange }
		await releaseTranscriptBodies(stored)
		this.transcript.push(stored)
		this.stored.set(exchange.seq, stored)
		await this.spool.keep(stored)
		if (stored.operationId !== undefined) {
			const list = this.byOperationId.get(stored.operationId) ?? []
			list.push(stored)
			this.byOperationId.set(stored.operationId, list)
		}
		if (entity !== undefined) {
			const list = this.byEntity.get(entity) ?? []
			list.push(stored)
			this.byEntity.set(entity, list)
		}
	}

	private readonly stored = new Map<number, Exchange>()
	private readonly spool = new BodySpool()

	/**
	 * The exchange with its bodies, wherever they are kept. The transcript holds the most recent
	 * bodies in memory and moves older ones to disk once they pass a budget; a reader that judges
	 * bodies from the transcript — rather than from the exchange a request returned — asks here.
	 */
	hydrate(exchange: Exchange): Promise<Exchange> {
		return this.spool.hydrate(exchange)
	}

	/** Removes the bodies moved to disk. The client is not used after this. */
	async dispose(): Promise<void> {
		await this.spool.dispose()
	}

	/** Writes sent so far. A cached read taken before the latest write is stale. */
	writes = 0

	/** Marks an answer that was asked again: only the final answer is the backend's verdict. */
	private supersede(exchange: Exchange): void {
		const stored = this.stored.get(exchange.seq)
		if (stored !== undefined) stored.superseded = true
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
/** One shell word, whatever it holds: single-quoted, with each `'` closed, escaped and reopened. */
function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`
}

export function toCurl(exchange: Exchange, options: CurlOptions = {}): string {
	const redact = options.redact
	const target = redactUrl(exchange.url)
	const url =
		options.origin !== undefined && target.startsWith(options.origin)
			? `"$BASE${shellEscapeDouble(target.slice(options.origin.length))}"`
			: shellQuote(target)

	const parts = [`curl -i -X ${exchange.method} ${url}`]
	for (const [key, value] of Object.entries(exchange.requestHeaders)) {
		if (redact === undefined ? isSecretHeaderName(key) : redact.includes(key.toLowerCase())) {
			/* Preserve the scheme prefix ("Bearer ", "ApiKey ") so the variable holds only the
			 * secret and the script stays copy-pasteable. */
			const scheme = /^(\w+)\s+/.exec(value)?.[1]
			const rendered = scheme === undefined ? "$TOKEN" : `${scheme} $TOKEN`
			parts.push(`  -H "${shellEscapeDouble(key)}: ${rendered}"`)
			continue
		}
		parts.push(`  -H ${shellQuote(`${key}: ${redactText(value)}`)}`)
	}
	if (exchange.requestBody !== undefined) {
		for (const flag of curlBodyFlags(redactBody(exchange.requestBody))) parts.push(flag)
	}
	return parts.join(" \\\n")
}

/** A request body with secrets removed, keeping the shape `curlBodyFlags` understands. */
function redactBody(body: unknown): unknown {
	if (typeof body === "string") return redactText(body)
	if (isURLSearchParams(body)) {
		const out = new URLSearchParams()
		for (const [key, value] of body) out.append(key, isSecretJsonKey(key) ? REDACTED : redactText(value))
		return out
	}
	if (isFormData(body) || isFormSnapshot(body) || isRawBytes(body) || isBodyRef(body)) {
		return body
	}
	return redactJson(body)
}

function curlBodyFlags(body: unknown): string[] {
	if (isFormData(body) || isFormSnapshot(body)) {
		const flags: string[] = []
		if (isFormData(body)) {
			for (const [name, value] of body.entries()) {
				if (typeof value === "string") {
					flags.push(`  -F ${shellQuote(`${name}=${value}`)}`)
				} else {
					flags.push(`  -F ${shellQuote(`${name}=@${value.name};type=${value.type || "application/octet-stream"}`)}`)
				}
			}
			return flags
		}
		for (const part of body.parts) {
			if ("value" in part) {
				flags.push(`  -F ${shellQuote(`${part.field}=${part.value}`)}`)
			} else {
				flags.push(`  -F ${shellQuote(`${part.field}=@${part.filename};type=${part.mediaType}`)}`)
			}
		}
		return flags
	}
	if (isURLSearchParams(body)) {
		/* Field by field: curl encodes each value itself. Handing it the joined string encoded the
		 * separators too, so the server received one field holding the whole form. */
		return [...body].map(([key, value]) => `  --data-urlencode ${shellQuote(`${key}=${value}`)}`)
	}
	if (typeof body === "string") {
		return [`  -d ${shellQuote(body)}`]
	}
	if (isRawBytes(body) || isBodyRef(body)) {
		return [`  --data-binary @-`]
	}
	return [`  -d ${shellQuote(JSON.stringify(body))}`]
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
	/* Counted, not encoded: a copy of every body just to measure it is the cost to avoid. */
	return text === undefined || text === "" ? 0 : Buffer.byteLength(text, "utf8")
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
	bodyBytes: number,
): number {
	const sent = { ...headers }
	if (bodyBytes > 0 && !hasHeader(sent, "content-length")) sent["content-length"] = String(bodyBytes)
	const start = statusText === "" ? `HTTP/1.1 ${status}` : `HTTP/1.1 ${status} ${statusText}`
	return httpMessageBytes(start, sent, undefined, bodyBytes)
}

function httpMessageBytes(
	startLine: string,
	headers: Record<string, string>,
	body: string | undefined,
	bodyBytes = 0,
): number {
	let text = `${startLine}\r\n`
	for (const [key, value] of Object.entries(headers)) {
		text += `${key}: ${value}\r\n`
	}
	text += `\r\n`
	if (body !== undefined) text += body
	const headerBytes = Buffer.byteLength(text, "utf8")
	return body === undefined ? headerBytes + bodyBytes : headerBytes
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
	if (isFormSnapshot(body)) {
		const parts: Record<string, unknown> = {}
		for (const part of body.parts) {
			if ("value" in part) parts[part.field] = part.value
			else parts[part.field] = { bytes: part.bytes, filename: part.filename, mediaType: part.mediaType }
		}
		return parts
	}
	if (isURLSearchParams(body)) return body.toString()
	if (isRawBytes(body)) return { bytes: bodyByteLength(body) }
	if (isBodyRef(body)) return { bytes: body.bytes, mediaType: body.mediaType, sha256: body.sha256 }
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
