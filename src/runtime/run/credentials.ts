/** The run's principals as the client's credential source. */

import type { Credential, CredentialRequest, CredentialSource } from "../../client/credential-source.ts"

/** A principal's credential, bound so every request that carries it refreshes and 401-retries. */
export interface BoundCredential extends Credential {
	/** Whether `headers` carry this credential. */
	matches: (headers: Readonly<Record<string, string>>) => boolean
}

/**
 * Filled as the run resolves its principals: each acquired credential is bound when its login
 * succeeds, and the principals are named once all are resolved.
 */
export class RunCredentials implements CredentialSource {
	private readonly bound: BoundCredential[] = []
	private sender: ((headers: Readonly<Record<string, string>>) => string | undefined) | undefined

	bind(credential: BoundCredential): void {
		this.bound.push(credential)
	}

	/** Names a request's principal from the credential its own headers carry. */
	nameSenders(sender: (headers: Readonly<Record<string, string>>) => string | undefined): void {
		this.sender = sender
	}

	credentialFor(request: CredentialRequest): Credential | undefined {
		return this.bound.find((credential) => credential.matches(request.headers))
	}

	principalOf(headers: Readonly<Record<string, string>>): string | undefined {
		return this.sender?.(headers)
	}
}
