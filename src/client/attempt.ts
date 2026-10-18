/** The shapes one request attempt passes between preparing, sending and recording it. */

import type { Exchange } from "../runtime/exchange.ts"
import type { Fence } from "../runtime/fence.ts"
import type { CompiledRateLimitRule } from "../runtime/rate-limit/rules.ts"
import type { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import type { Credential, CredentialSource } from "./credential-source.ts"
import type { Landed } from "./redirect.ts"
import type { EncodedBody } from "./serialize.ts"
import type { Slots } from "./slots.ts"
import type {
	HeaderResolver,
	HttpHooks,
	NetworkClientOptions,
	OperationResolver,
	RequestOptions,
	ResolvedOperation,
} from "./types.ts"

/** A request as every attempt sends it. */
export interface Prepared {
	/** Upper-cased. */
	method: string
	url: URL
	/** The path below the base URL, which documented paths and rate-limit rules describe. */
	relative: string
	options: RequestOptions
	resolved: ResolvedOperation | null
	operationId: string | undefined
	/** The caller's headers, read afresh: a getter returns the live credential on a retry. */
	callerHeaders: () => Record<string, string>
	/** The bound credential the caller's headers carry, unless auth refresh is skipped. */
	credential: (headers: Record<string, string>) => Credential | undefined
}

/** What the client lends each attempt. */
export interface Wire {
	baseUrl: string
	headers: Record<string, string>
	resolveHeaders: HeaderResolver | undefined
	operationResolver: OperationResolver | undefined
	credentials: CredentialSource | undefined
	fence: Fence | undefined
	rateLimiter: RateLimiter | undefined
	slots: Slots
	httpHooks: HttpHooks | undefined
	network: NetworkClientOptions | undefined
	relativePath: (url: URL) => string
	nextSeq: () => number
	/** Hands the exchange to the run and keeps it, under the entity its operation names. */
	deliver: (exchange: Exchange, entity: string | undefined) => Promise<void>
}

/** What one attempt sent, for the exchange it leaves. */
export interface Sent {
	request: Prepared
	attempt: number
	headers: Record<string, string>
	/** The caller's headers with the credential: whose they are names the principal. */
	caller: Record<string, string>
	body: EncodedBody
}

/** The rate-limit rule an attempt is paced by: a tagged route's, or the implicit one for its method. */
export interface Pacing {
	rule: CompiledRateLimitRule
	tagged: boolean
}

/** The last hop's answer, and when the attempt went out and came back. */
export interface Timed extends Landed {
	at: number
	started: number
	/** Whether the rate limit had room without waiting; `undefined` when nothing paced it. */
	room: boolean | undefined
}
