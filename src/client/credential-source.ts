/**
 * The client's port to credentials: what a request carries, and whose it is.
 *
 * The client never logs in or decides placement itself. It asks the source which credential the
 * caller's headers carry, sends that credential's live headers, refreshes it when stale, and
 * retries once after a refresh on a 401. The run's principals implement it.
 */

/** What the client knows about a request when it asks for its credential. */
export interface CredentialRequest {
	/** The caller's own headers, before any credential is added. */
	headers: Readonly<Record<string, string>>
	operationId?: string
}

/** One principal's credential, bound for the run. */
export interface Credential {
	/** The headers that carry it now: read on every attempt, so a retry sends the refreshed one. */
	headers: () => Record<string, string>
	/** Refreshes it when stale, or always with `force`. A failure is the backend's, not the request's. */
	refreshIfStale: (force?: boolean) => Promise<void>
}

export interface CredentialSource {
	/** The credential `request` carries, or `undefined` when it carries none this source holds. */
	credentialFor: (request: CredentialRequest) => Credential | undefined
	/** The principal whose credential `headers` carry, named on the exchange. */
	principalOf: (headers: Readonly<Record<string, string>>) => string | undefined
}
