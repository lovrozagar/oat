/**
 * Public config surface. Everything backend-specific lives here or in spec `x-*` tags —
 * oat itself contains no knowledge of any particular API.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface HttpRequest {
	method: string
	path: string
	headers?: Record<string, string>
	query?: Record<string, string>
	body?: unknown
}

export interface HttpResponse {
	status: number
	headers: Record<string, string>
	body: unknown
	raw: string
	durationMs: number
}

/**
 * One step in an auth chain. `saveAs` binds parts of the response into a scope that later
 * steps interpolate with `{name}`. Values are addressed by JSON pointer-ish path (`$.a.b[0]`).
 */
export interface AuthStep {
	/** Prefer `operationId` — it keeps the config spec-relative rather than URL-relative. */
	operationId?: string
	request?: HttpRequest
	saveAs?: Record<string, string>
	/**
	 * Declares this step needs a value delivered outside HTTP (verification token, OTP).
	 * oat calls `hooks.resolveOutOfBand` and binds the result under `as`.
	 */
	outOfBand?: { address: string; kind: string; as: string }
	/** Statuses that are acceptable for this step. Defaults to any 2xx. */
	expect?: number[]
}

export interface AuthFlow {
	acquire: AuthStep[]
	refresh?: {
		operationId?: string
		request?: HttpRequest
		credentialFrom: string
		expiresInFrom?: string
		refreshTokenFrom?: string
	}
	credentialFrom?: string
	expiresInFrom?: string
	/** Fallback when the credential carries no discoverable expiry. */
	assumeTtlMs?: number
	inject: { header: string; template: string }
}

export interface PrincipalConfig {
	id: string
	/** Must land in a different tenant than the named principal — powers the isolation matrix. */
	isolateFrom?: string
	flow?: string
}

export interface OutOfBandRequest {
	address: string
	kind: string
	attempt: number
}

export interface Hooks {
	/**
	 * Resolve a value delivered outside HTTP — verification token, magic link, OTP.
	 * Called with backoff; return `null` to retry, throw to fail the flow.
	 * This is the entire backend-coupling surface of oat.
	 */
	resolveOutOfBand?: (req: OutOfBandRequest) => Promise<string | null>
	/** Cascade-delete a principal created during the run. */
	teardownPrincipal?: (address: string) => Promise<void>
}

export type Profile = "smoke" | "crud" | "deep" | "paranoid"

export interface OatConfig {
	spec: string
	baseUrl: string
	/** Sent on every request. Opaque to oat — bypass headers, API versioning, tracing. */
	globalHeaders?: Record<string, string>
	auth?: {
		flows: Record<string, AuthFlow>
		principals: PrincipalConfig[]
		hooks?: Hooks
	}
	/** Resources with no create operation. Also declarable in-spec via `x-root`. */
	roots?: Record<string, string>
	profile?: Profile
	seed?: number
	concurrency?: number
	/** `operationId` or `operationId:caseKind`. */
	skip?: string[]
	only?: string[]
	outDir?: string
	/** Per-entity cohort size for discriminating fixtures. */
	cohortSize?: number
	timeoutMs?: number
}

export function defineConfig(config: OatConfig): OatConfig {
	return config
}
