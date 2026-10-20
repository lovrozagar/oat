/** HTTP client with a full transcript, so every finding can cite the exchange that produced it. */

import type { Redactor } from "../security/redact.ts"
import type { Exchange } from "../runtime/exchange.ts"
import { belowBase } from "./curl.ts"
import { Journal } from "./journal.ts"
import { afterUnauthorized } from "./refresh.ts"
import type { Wire } from "./attempt.ts"
import { prepare, sendAttempt } from "./request.ts"
import { DEFAULT_DEADLINE_MS, resilient, untilAnswered } from "./retry.ts"
import { Slots } from "./slots.ts"
import type { ClientOptions, ExchangeContext, RequestOptions, SafeMethod } from "./types.ts"

const SAFE_METHODS: ReadonlySet<string> = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"])

/** A client that can only read: what a check that does not mutate receives. */
export interface ReadClient extends Omit<Client, "request" | "view"> {
	request(method: SafeMethod, path: string, options: RequestOptions): Promise<Exchange>
	view(context: ExchangeContext): ReadClient
}

export class Client {
	/** Writes sent so far. A cached read taken before the latest write is stale. */
	writes = 0
	private seq = 0
	private afterExchange: ((exchange: Exchange) => Promise<void>) | undefined
	/* Not `#private`: a view is a Proxy, and a private field does not read through one. */
	private readonly journal: Journal
	private readonly wire: Wire

	constructor(private readonly options: ClientOptions) {
		this.journal = new Journal(options.redactor)
		this.wire = {
			baseUrl: options.baseUrl,
			credentials: options.credentials,
			deliver: async (exchange, entity) => {
				await options.onExchange?.(exchange)
				await this.journal.record(exchange, entity)
			},
			fence: options.fence,
			headers: options.headers ?? {},
			httpHooks: options.httpHooks,
			network: options.network,
			nextSeq: () => ++this.seq,
			operationResolver: options.operationResolver,
			rateLimiter: options.rateLimiter,
			redactor: options.redactor,
			relativePath: (url) => this.relativePath(url),
			resolveHeaders: options.resolveHeaders,
			slots: new Slots(options.maxInFlight ?? 4),
		}
	}

	/** Every exchange, with bodies compacted for memory. */
	get transcript(): Exchange[] {
		return this.journal.transcript
	}

	/** What this client's transcript is scrubbed with: one per run, shared by its origin clients. */
	get redactor(): Redactor {
		return this.options.redactor
	}

	/**
	 * Awaited with every answer before `request` returns it, from whichever view sent it, once the
	 * request's in-flight slot is free: a callback that sends its own request never waits on it.
	 */
	setAfterExchange(fn: (exchange: Exchange) => Promise<void>): void {
		this.afterExchange = fn
	}

	/** The path below the base URL — what a documented path template describes. */
	relativePath(url: URL | string): string {
		const pathname = typeof url === "string" ? new URL(url).pathname : url.pathname
		const base = new URL(this.options.baseUrl).pathname.replace(/\/$/, "")
		const below = base === "" ? undefined : belowBase(pathname, base)
		return below === undefined ? pathname : below || "/"
	}

	/** Exchanges that resolved to an operation of `entity`, in order. */
	exchangesForEntity(entity: string): readonly Exchange[] {
		return this.journal.exchangesForEntity(entity)
	}

	/** Exchanges that resolved to `operationId`, in order. */
	exchangesFor(operationId: string): readonly Exchange[] {
		return this.journal.exchangesFor(operationId)
	}

	/**
	 * A client that stamps every request it sends with `context`. Checks each get their own, so
	 * an exchange names the check that issued it even while checks run concurrently.
	 */
	view(context: ExchangeContext, readOnly = false): Client {
		const request = (method: string, path: string, options: RequestOptions): Promise<Exchange> => {
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
					return (path: string, options: RequestOptions) => (receiver as Client).request("GET", path, options)
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

	/** Sends one request as `options.as`, renewing its credential once after a 401 and asking once more. */
	async request(method: string, path: string, options: RequestOptions): Promise<Exchange> {
		if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") this.writes += 1
		const request = prepare(this.wire, method, path, options)
		const { network, rateLimiter } = this.options
		const deadline = performance.now() + (network?.deadlineMs ?? DEFAULT_DEADLINE_MS)
		const policy = { deadline, headers: request.callerHeaders, method: request.method, network }
		const send = (): Promise<Exchange> => resilient((attempt) => sendAttempt(request, attempt, this.wire), policy)
		const supersede = (exchange: Exchange): void => this.journal.supersede(exchange)
		const reauthorized = (exchange: Exchange): Promise<Exchange> =>
			afterUnauthorized(exchange, { renew: request.credential.renew, send, supersede })
		const exchange = await untilAnswered(await reauthorized(await send()), {
			again: (previous) => {
				supersede(previous)
				return send()
			},
			backedOff: (waitMs) =>
				rateLimiter?.noteBackoff(
					{ method: request.method, operationId: request.operationId, pathname: request.relative },
					waitMs,
				),
			method: request.method,
			reauthorized,
		})
		await this.afterExchange?.(exchange)
		return exchange
	}

	get(path: string, options: RequestOptions): Promise<Exchange> {
		return this.request("GET", path, options)
	}

	/** The exchange with its bodies, wherever the transcript keeps them. */
	hydrate(exchange: Exchange): Promise<Exchange> {
		return this.journal.hydrate(exchange)
	}

	/** Removes the bodies moved to disk. The client is not used after this. */
	async dispose(): Promise<void> {
		await this.journal.dispose()
	}
}
