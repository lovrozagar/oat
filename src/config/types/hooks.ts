/* The functions a config passes oat, and what each receives and returns. */

import type { FilterableField, QueryCapabilities } from "./query.ts"

export interface OutOfBandRequest {
	address: string
	kind: string
	/** 1-based; oat retries with backoff until a value arrives or the attempts run out. */
	attempt: number
	/** Flow scope at this step (interpolated binds + prior `saveAs`). */
	scope: Record<string, string>
	/**
	 * When the request this value answers was sent (unix ms): the latest earlier request in the
	 * flow or scenario that named `address` in its URL or body. An inbox also holds what earlier
	 * requests triggered, and those can arrive late: a value delivered before this moment answers
	 * some other request. Absent when no request named the address, or the step is `sentEarlier`.
	 */
	since?: number
}

/** Where a credential goes on one request: header, query parameter and cookie values by name, as its scheme places it. */
export interface Sends {
	headers: Record<string, string>
	query: Record<string, string>
	cookies: Record<string, string>
}

export interface TeardownPrincipalContext {
	/** The principal's credential as the run last held it: the latest issued, not a cleared snapshot. */
	credential: string
	/** Where that credential goes, as its scheme places it, ready to send on the removing request. */
	sends: Sends
}

/** The principal `hooks.resolveCredential` gets a credential for: its id and its identity data. */
export interface CredentialPrincipal {
	id: string
	identity: Readonly<Record<string, unknown>>
}

/** A credential `hooks.resolveCredential` returns: the value, or the value and its lifetime in seconds. */
export type CredentialAnswer = string | { value: string; expiresIn?: number }

/**
 * Poll schedule for `resolveOutOfBand`.
 *
 * Defaults match 0.6.2: 6 attempts, 200 ms first sleep, doubling, cap 3000 ms.
 * Worst-case wait is the sum of every sleep, including after the last miss:
 * `200+400+800+1600+3000+3000 = 9000` ms. `{ attempts: 20, initialMs: 1000, maxMs: 8000 }`
 * is `1000+2000+4000+8000×17 = 143000` ms. The hook must not sleep; oat owns the backoff.
 */
export interface OutOfBandConfig {
	attempts?: number
	initialMs?: number
	maxMs?: number
}

export interface HeaderRequest {
	method: string
	url: string
	operationId?: string
}

export interface InputRequest {
	operationId: string
	/** Property name at this depth. */
	field: string
	/** JSON-path style pointer, e.g. `$.payment_method_id`. */
	pointer: string
	schema: unknown
	/**
	 * Value the generator put on this field. `undefined` when the field was left out
	 * (a required-field probe). A string or array outside `schema` max/min bounds is a
	 * constraint probe. Return `null` to send that value unchanged.
	 */
	value: unknown
}

export interface SideEffectRequest {
	/** The write that should have produced the side effect. */
	operationId: string
	/** Latest poll body, or the write response when no poll has landed yet. */
	record: unknown
	attempt: number
}

export interface UploadRequest {
	operationId: string
	/** The request's multipart / json / urlencoded media type. */
	mediaType: string
	/** Form part name. */
	field: string
	/** Part's declared type, e.g. `application/pdf`. */
	contentMediaType?: string
	filename?: string
	/** Cohort variant. */
	variant: string
	index: number
	/** Set when `uploads.each` is driving this invocation. */
	fixture?: {
		path: string
		filename: string
		index: number
		total: number
	}
}

export interface UploadFile {
	bytes: Uint8Array
	filename: string
	mediaType: string
}

/**
 * Exact body or part. `null` falls through to each / pool / dummy.
 * `UploadFile` replaces that field.
 * `{ fields }` that includes a file part replaces the whole request.
 * `{ fields }` that omits the file part overlays scalars and keeps each / pool / dummy bytes.
 */
export type UploadResolution = UploadFile | { fields: Record<string, string | UploadFile> } | null

export interface Uploads {
	/**
	 * Files oat may pick from. Globs and directories, relative to the config file.
	 * Matched by extension / sniffed type against the part's contentMediaType.
	 * Same seed → same pick. Empty match → dummy (do not fail the run).
	 */
	pool?: string[]
	/**
	 * operationId → globs / paths, relative to the config file.
	 * Present → that operation is invoked once per matched file (after eachMax).
	 * Absent → pick-one (resolveUpload → pool → dummy).
	 */
	each?: Record<string, string[]>
	/** Per-operation cap on `each` matches. Default: no cap. */
	eachMax?: number
}

/** A request about to leave the process, as `hooks.beforeRequest` sees it. */
export interface FenceRequest {
	method: string
	url: string
	headers: Record<string, string>
	body: unknown
	operationId?: string
	/** Why oat is sending it: `load`, `auth`, `seed`, `assertion`, `probe`, `teardown`, or `request`. */
	phase: string
	/** The principal whose credential it carries; absent when it carries none, or a forged one. */
	principal?: string
	/** The security schemes whose credentials it carries; absent when it carries none. */
	schemes?: string[]
	/** Set when the credential is a forged value a probe sends on purpose. */
	forged?: true
}

/** Let the request go, or refuse it with a reason the report shows. */
export type FenceDecision = { allow: true } | { allow: false; reason: string }

/** A record teardown counted removed, or could not show gone, as `hooks.verifyRemoved` is asked about it. */
export interface RemovedRecord {
	entity: string
	id: string
	/** Path parameters in scope when the record was created. */
	scope: Record<string, string>
	/** The configured principal that created it. */
	principal: string
}

/** What a store outside HTTP says about a record: still there, gone, or cannot tell. */
export type RemovalVerdict = "present" | "absent" | "unknown"

export interface Hooks {
	/**
	 * Sees every request before it leaves the process and may refuse it. A refused request is never
	 * sent and never judged: its check is unresolved, its cohort blocked, its record a leftover. The
	 * report lists every refusal, and the run fails unless `fence.failRun` is false.
	 */
	beforeRequest?: (request: FenceRequest) => FenceDecision | Promise<FenceDecision>
	/**
	 * Performs a scenario `external` step — a browser payment, an OAuth consent — and returns
	 * the value the next step needs. `null` fails the step.
	 */
	external?: (name: string, input: Record<string, unknown>) => Promise<string | null>
	/** Return `null` to ask oat to retry — the value may simply not have arrived yet. */
	resolveOutOfBand?: (request: OutOfBandRequest) => Promise<string | null>
	/**
	 * Removes a principal the run provisioned, and everything that principal created with it.
	 * `ctx.credential` is its live credential and `ctx.sends` where its scheme places it, so an
	 * authenticated delete-account is expressible without a tester-key god route. Address stays — some backends still key
	 * teardown on it. One-argument JavaScript callbacks still run (the second argument is
	 * extra); TypeScript configs should take `ctx`.
	 */
	teardownPrincipal?: (address: string, ctx: TeardownPrincipalContext) => Promise<void>
	/**
	 * Asked, after teardown, about every record it counted removed and every one it could not show
	 * gone — a record its creator could never read back. Answer from somewhere HTTP does not reach,
	 * the database say: `"present"` makes the record a leftover, `"absent"` clears it, `"unknown"`
	 * keeps teardown's own verdict. A hook that throws counts as `"unknown"`, and the run notes it.
	 */
	verifyRemoved?: (record: RemovedRecord) => RemovalVerdict | Promise<RemovalVerdict>
	/**
	 * Exact file or whole request. Return `null` to fall through to `uploads.each`, then pool, then a dummy.
	 * `UploadFile` replaces that field. `{ fields }` with a file replaces the whole request.
	 * `{ fields }` without the file part overlays scalars and keeps the each / pool / dummy bytes.
	 * A hook that ignores `request.fixture` and always returns the same file will send that file N times.
	 */
	resolveUpload?: (request: UploadRequest) => Promise<UploadResolution>
	/**
	 * Per-request headers, merged after `globalHeaders` and before the principal's credential.
	 * Called on every dispatch (including 401 retries) so a one-shot captcha token can be fresh.
	 * Return `null` or `{}` to add nothing. oat does not speak Turnstile.
	 */
	resolveHeaders?: (request: HeaderRequest) => Promise<Record<string, string> | null>
	/**
	 * Replace a generated JSON field. Return `null` to keep the generator, including a field
	 * the check left out or sized past the schema. `request.value` is that generated value.
	 * Same idea as `resolveUpload`, for JSON (Stripe `pm_…`, vendor tokens).
	 */
	resolveInput?: (request: InputRequest) => Promise<unknown | null>
	/**
	 * The credential for a `{ hook: true }` recipe: the scheme's name and the principal it is for.
	 * Called on every acquire, so a TOTP code is fresh each time. Return the value, or the value with
	 * its lifetime in seconds. `null` blocks that principal for that scheme, with the reason in the report.
	 */
	resolveCredential?: (scheme: string, principal: CredentialPrincipal) => Promise<CredentialAnswer | null>
	/**
	 * A path parameter the document does not let oat create (an account provider with no row yet).
	 * Return the value to send, or `null` to leave the operation unresolved. Product doors stay
	 * in the hook. The request names the principal, and the credential and placement the operation
	 * would carry as it, so the hook can decode a token or call the API as that principal.
	 */
	resolvePathValue?: (request: PathValueRequest) => Promise<string | null>
	/**
	 * After a write that declares `x-wait`, return `true` when the side effect is visible.
	 * `null` retries until `x-wait.timeoutMs` (default 30s).
	 */
	awaitSideEffect?: (request: SideEffectRequest) => Promise<true | null>
	/**
	 * After seed, add or replace any axis of the query catalog for one entity. Return `null`
	 * to keep the merged tag+config catalog. A provided `filterable` / `sortable` /
	 * `searchable` / `selectable` list replaces that axis; omitted axes stay. `get` runs a
	 * named operation (or `"GET /path"`) with the seeded scope so a follow-up read can
	 * harvest dynamic columns.
	 */
	resolveQueryCapabilities?: (
		request: QueryCapabilitiesRequest,
	) => Promise<FilterableField[] | Partial<QueryCapabilities> | null>
}

export interface PathValueRequest {
	operationId: string
	param: string
	method: string
	path: string
	/** Enum values the path parameter declares. Empty when the document lists none. */
	enumValues: string[]
	/** The principal the value is resolved for, by id, as `resolveCredential` names it. */
	principal: string
	/** The parameters bound for that principal (its config `scope`, and what its login's claims bound). */
	scope: Readonly<Record<string, string>>
	/** Its identity data: config values, a fresh signup's, a login's claims. */
	identity: Readonly<Record<string, unknown>>
	/** The credential the operation would carry as that principal, e.g. a JWT to decode. Absent when it sends none. */
	credential?: string
	/** Where that credential goes, as the operation's security places it: enough to call the API as the principal. */
	sends?: Sends
}

export interface QueryCapabilitiesRequest {
	entity: string
	scope: Record<string, string>
	get: (operationId: string, scope?: Record<string, string>) => Promise<unknown>
}
