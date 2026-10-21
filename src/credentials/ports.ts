import type { Hooks } from "../config/types/hooks.ts"
import type { AuthStep } from "../config/types/steps.ts"

/*
 * What the runtime lends the credentials library. Sending a request needs the run's clients, paths
 * and body encoders, which sit above this layer, so the library asks for them through these ports
 * and the run injects them.
 */

export type { Sends } from "../config/types/hooks.ts"

/** What an answer gives a recipe to read a credential, a lifetime or a claim from. */
export interface StepAnswer {
	status: number
	body: unknown
	headers: Readonly<Record<string, string>>
	cookies: Readonly<Record<string, string>>
}

/** How a credential hop is sent: `probe` when it is meant to be refused, so its exchange is labeled one. */
export interface Hop {
	probe?: true
}

/**
 * Runs login and refresh steps, each once: `bind`, `saveAs`, `saveClaimsFrom` and `outOfBand` as in a
 * scenario. It resolves with the scope the steps bound and the last answer, and rejects with an Error
 * whose message is the reason when a step fails or a value is missing.
 */
export interface StepRunner {
	run(
		steps: readonly AuthStep[],
		input: {
			principal: string
			scope: Readonly<Record<string, string>>
			/** Where each answer holds a credential: registered as secrets before the answer is recorded. */
			secrets?: readonly string[]
		} & Hop,
	): Promise<{ scope: Record<string, string>; answer: StepAnswer }>
}

/**
 * Calls a documented operation as a principal sending one scheme, for mint and revoke: the run's
 * client places that scheme's credential, refreshing it on a 401 like any request. `scope` fills
 * the operation's path parameters, over the principal's own. It resolves with whatever the backend
 * answered, and rejects with the reason when the principal holds no credential for the scheme.
 */
export interface OperationCaller {
	call(input: {
		operationId: string
		body?: unknown
		as: { principal: string; scheme: string }
		scope?: Readonly<Record<string, string>>
		/**
		 * Send this value as the scheme's credential, placed and redacted like it, instead of what the
		 * principal holds: the one session a revoke ends. Never renewed on a 401.
		 */
		value?: string
		/** Where the answer holds a credential, as `from` addresses it: a secret before the answer is recorded. */
		secrets?: readonly string[]
	}): Promise<StepAnswer>
}

/** POSTs a form, `application/x-www-form-urlencoded`, to an OAuth 2 token URL. */
export interface TokenPoster {
	post(url: string, form: Readonly<Record<string, string>>, hop?: Hop): Promise<StepAnswer>
}

/** `hooks.resolveCredential`, as a `{ hook: true }` recipe calls it. */
export type CredentialHook = NonNullable<Hooks["resolveCredential"]>

/** Every port a run lends the credentials library. The hook is absent when the config sets none. */
export interface CredentialPorts {
	steps: StepRunner
	operations: OperationCaller
	tokens: TokenPoster
	resolveCredential?: CredentialHook
}
