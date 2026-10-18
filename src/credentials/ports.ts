import type { Hooks } from "../config/types/hooks.ts"
import type { AuthStep } from "../config/types/steps.ts"

/*
 * What the runtime lends the credentials library. Sending a request needs the run's clients, paths
 * and body encoders, which sit above this layer, so the library asks for them through these ports
 * and the run injects them.
 */

/** Where a credential goes on one request: header, query parameter and cookie values by name. */
export interface Sends {
	headers: Record<string, string>
	query: Record<string, string>
	cookies: Record<string, string>
}

/** What an answer gives a recipe to read a credential, a lifetime or a claim from. */
export interface StepAnswer {
	status: number
	body: unknown
	headers: Readonly<Record<string, string>>
	cookies: Readonly<Record<string, string>>
}

/**
 * Runs login and refresh steps, each once: `bind`, `saveAs`, `saveClaimsFrom` and `outOfBand` as in a
 * scenario. It resolves with the scope the steps bound and the last answer, and rejects with an Error
 * whose message is the reason when a step fails or a value is missing.
 */
export interface StepRunner {
	run(
		steps: readonly AuthStep[],
		input: { principal: string; scope: Readonly<Record<string, string>> },
	): Promise<{ scope: Record<string, string>; answer: StepAnswer }>
}

/**
 * Calls a documented operation with the given credential sends, for mint and revoke. `scope` fills
 * the operation's path parameters. It resolves with whatever the backend answered.
 */
export interface OperationCaller {
	call(input: {
		operationId: string
		body?: unknown
		sends: Sends
		scope?: Readonly<Record<string, string>>
	}): Promise<StepAnswer>
}

/** POSTs a form, `application/x-www-form-urlencoded`, to an OAuth 2 token URL. */
export interface TokenPoster {
	post(url: string, form: Readonly<Record<string, string>>): Promise<StepAnswer>
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
