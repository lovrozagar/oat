/** The shapes one request attempt passes between preparing, sending and recording it. */

import type { Controls } from "./control.ts"
import type { Exchange } from "../runtime/exchange.ts"
import type { Fence } from "../runtime/fence.ts"
import type { CompiledRateLimitRule } from "../runtime/rate-limit/rules.ts"
import type { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import type { Redactor } from "../security/redact.ts"
import type { CredentialSource } from "./credential-source.ts"
import type { Placement, RequestCredential } from "./placing.ts"
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
	/** Query parameters the caller set, before the operation's required ones were added. */
	callerQuery: ReadonlySet<string>
	/** The caller's headers, read afresh on every attempt. */
	callerHeaders: () => Record<string, string>
	/** What each attempt places, and the one renewal a 401 allows. */
	credential: RequestCredential
}

/** What the client lends each attempt. */
export interface Wire {
	baseUrl: string
	headers: Record<string, string>
	resolveHeaders: HeaderResolver | undefined
	operationResolver: OperationResolver | undefined
	credentials: CredentialSource | undefined
	/** The control reads that judge a renewal refused too; one per client. */
	controls: Controls
	/** Every credential a request places registers here; one per run. */
	redactor: Redactor
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
	/** The URL this attempt went to: the request's, with any query credential placed. */
	url: URL
	headers: Record<string, string>
	/** The credential the attempt carried, which names its principal and schemes on the exchange. */
	placement: Placement
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
