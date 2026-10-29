/** The client's request, wiring and policy shapes. */

import type { NetworkInterfaceInfo } from "node:os"
import type { HeaderRequest } from "../config/types/hooks.ts"
import type { Redactor } from "../security/redact.ts"
import type { Exchange, Purpose, SchemaVerdict } from "../runtime/exchange.ts"
import type { Fence } from "../runtime/fence.ts"
import type { NetworkError } from "../errors/network.ts"
import type { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import type { Actor, CredentialSource } from "./credential-source.ts"
import type { SpoolOptions } from "../runtime/transcript/spool.ts"
import type { ParamStyles } from "../spec/graph/parameters.ts"
import type { CacheBypass } from "../spec/extensions/consistency.ts"

export type { SafeMethod } from "../spec/methods.ts"

/** Who is asking, and why: carried onto every exchange a view sends. */
export interface ExchangeContext {
	check?: string
	subject?: string
	purpose?: Purpose
	/**
	 * Where each answer holds a credential, as a recipe's `from` or `saveAs` addresses it: a JSON path
	 * of the body, `header:<name>` or `cookie:<name>`. What is there registers on the redactor before
	 * the exchange is recorded, so the journal never writes it down, whatever its key is called.
	 */
	secrets?: readonly string[]
	/** The credential store sent it: what it creates is the store's to revoke, never a ledgered record. */
	issuedBy?: "credentials"
}

/** The documented operation a request is an instance of. */
export interface ResolvedOperation {
	operationId: string
	template: string
	entity?: string | null
	redirects?: boolean
	/** Required parameters the request is sent with unless it sets them: the document's values. */
	requiredQuery?: Record<string, unknown>
	requiredHeaders?: Record<string, unknown>
	requiredCookies?: Record<string, unknown>
	/** How each parameter is written, where the document says other than the OAS default. */
	paramStyles?: ParamStyles
	pathParams?: Record<string, string>
	/** The `x-consistency` bypass a read declares; a read without one is sent `Cache-Control: no-cache`. */
	bypass?: CacheBypass | null
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
	/**
	 * Who the request acts as. There is no default: anonymous is `{ anonymous: true }`. The credential
	 * it sends comes from this and the operation's security, never from `headers`.
	 */
	as: Actor
	/** The request expects a refusal: a 401 is its answer, never refreshed or retried. A forged actor is always one. */
	probe?: boolean
	/** Non-credential headers only: one under a name the credential is placed in is a `CredentialCollision`. */
	headers?: Record<string, string> | (() => Record<string, string>)
	/**
	 * Each value is written in the style the resolved operation declares for it; by default an array
	 * repeats the parameter once per item, in order, and an object spreads its keys.
	 */
	query?: Record<string, unknown>
	/** Plain object (JSON), FormData, URLSearchParams, or any BodyInit. */
	body?: unknown
	/**
	 * Explicit type, or `null` when headers are already final.
	 * FormData never gets a Content-Type here — fetch must set the boundary.
	 */
	contentType?: string | null
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
	/** `use` reads as a client would, past no cache: the staleness measurement. Default `bypass`. */
	cache?: "bypass" | "use"
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
	/** The config's `cache.bypass`. Default true: every documented read asks past the caches. */
	cacheBypass?: boolean
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
	/** What each request's actor sends. Without one, only anonymous requests can be sent. */
	credentials?: CredentialSource | undefined
	/** How much of the transcript's bodies stays in memory, and where the encrypted rest is spooled. */
	transcript?: SpoolOptions | undefined
	/**
	 * The schema verdict on a response body the transcript keeps only by reference, taken while the
	 * whole body is still at hand; `undefined` when its operation documents no schema for the status.
	 */
	validateAtCapture?: ((exchange: Exchange) => SchemaVerdict | undefined) | undefined
}
