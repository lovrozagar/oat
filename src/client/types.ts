/** The client's request, wiring and policy shapes. */

import type { NetworkInterfaceInfo } from "node:os"
import type { HeaderRequest } from "../config/types/hooks.ts"
import type { Redactor } from "../security/redact.ts"
import type { Exchange, Purpose } from "../runtime/exchange.ts"
import type { Fence } from "../runtime/fence.ts"
import type { NetworkError } from "../runtime/network.ts"
import type { RateLimiter } from "../runtime/rate-limit.ts"
import type { CredentialSource } from "./credential-source.ts"

/** Methods that cannot change server state. */
export type SafeMethod = "GET" | "HEAD" | "OPTIONS"

/** Who is asking, and why: carried onto every exchange a view sends. */
export interface ExchangeContext {
	check?: string
	subject?: string
	purpose?: Purpose
}

/** The documented operation a request is an instance of. */
export interface ResolvedOperation {
	operationId: string
	template: string
	entity?: string | null
	redirects?: boolean
	requiredQuery?: Record<string, string>
	pathParams?: Record<string, string>
}

/** Maps a request to the documented operation it is an instance of. */
export type OperationResolver = (method: string, relativePath: string) => ResolvedOperation | null

/** Per-request headers from the config's `resolveHeaders` hook; `null` adds none. */
export type HeaderResolver = (request: HeaderRequest) => Promise<Record<string, string> | null>

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
	/** An array is sent as the parameter repeated once per item, in order. */
	query?: Record<string, string | number | readonly (string | number)[] | undefined>
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

/** Optional retry / wait-for-link policy. Unset keeps today's "throw and hope". */
export interface NetworkClientOptions {
	retries?: number
	requestTimeoutMs?: number
	/** Total time one request may take across every attempt and wait. */
	deadlineMs?: number
	awaitRecovery?: (error: NetworkError) => Promise<boolean>
	/** The transport. The global `fetch` unless a caller supplies its own. */
	fetchImpl?: typeof fetch
	/** This machine's network interfaces, read to tell a failed request from being offline. `os.networkInterfaces` unless given. */
	interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
}

export interface ClientOptions {
	baseUrl: string
	/** What the transcript, curl and reports scrub with: one per run, shared by its origin clients. */
	redactor: Redactor
	/** Sent on every request, under everything else. */
	headers?: Record<string, string> | undefined
	/**
	 * Requests allowed in flight at once. Default 4.
	 *
	 * Parallelism past a server's comfort makes every request slower rather than the run
	 * faster — many APIs queue or throttle, so an unbounded burst trades wall-clock for
	 * nothing and risks tripping rate limits that then look like backend defects.
	 */
	maxInFlight?: number | undefined
	onExchange?: (exchange: Exchange) => void | Promise<void> | undefined
	/** Paces requests per declared category. */
	rateLimiter?: RateLimiter | undefined
	/** Observes each dispatch. `start` runs just before `fetch`; `end` always follows. */
	httpHooks?: HttpHooks | undefined
	network?: NetworkClientOptions | undefined
	/** Every request, redirect hops included, asks this first; a refused one is never sent. */
	fence?: Fence | undefined
	/** Per-request headers, merged after `headers` and before the principal's credential. */
	resolveHeaders?: HeaderResolver | undefined
	operationResolver?: OperationResolver | undefined
	credentials?: CredentialSource | undefined
}
