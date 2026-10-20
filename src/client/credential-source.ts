/**
 * The client's port to credentials: who a request acts as, and what that sends.
 *
 * Every request names its actor. The client never infers one from headers, never logs in and never
 * decides placement: it asks the source to resolve the actor against the operation's security, places
 * what comes back on every attempt, and on a 401 refreshes it once and retries once. A run implements
 * the source over its credential store (`createCredentialSource`).
 */

import type { Sends } from "../credentials/ports.ts"
import type { Exchange } from "../runtime/exchange.ts"
import type { PlacedSecrets } from "../security/redact.ts"

/** Who a request acts as. */
export type Actor =
	/** A principal: the operation's resolved security decides the scheme or schemes. */
	| { principal: string }
	/** A principal sending one named scheme: a scenario step's `scheme`, or a raw request. */
	| { principal: string; scheme: string }
	/**
	 * A principal following a URL a response gave it: a next link, a Location, a poll or receipt URL. It
	 * resolves against the operation the URL matches, else sends the schemes `via` recorded, and sends
	 * nothing to another origin.
	 */
	| { principal: string; via: Exchange }
	/** Nobody: nothing is sent. */
	| { anonymous: true }
	/** A value placed exactly like the scheme's credential, though no principal holds it: implicitly a probe. */
	| { forged: { scheme: string; value: string } }

/** What the client knows about a request when it resolves its credential. */
export interface CredentialRequest {
	operationId?: string
	/** `<METHOD> <path>`, the path below the base, or origin and path for another origin: what a refusal names. */
	route: string
	actor: Actor
	/** The request expects a refusal: it is never refreshed and never retried on a 401. */
	probe?: boolean
}

/** What a request sends, by scheme, in the order its alternative names them. */
export type SendsByScheme = Readonly<Record<string, Sends>>

/** A principal's credentials for the alternative it satisfies, placed and ready to send. */
export interface Sending {
	kind: "sends"
	principal: string
	schemes: string[]
	sends: SendsByScheme
	/** The value each scheme carried, which a refresh names so a newer one is not renewed again. */
	sentValues: Readonly<Record<string, string>>
	/** Every name and value placed, for the run's redactor. */
	secrets: PlacedSecrets
	/** Renews what this resolution sent, single-flight across every request that sent it. */
	refresh(): Promise<Resolution>
}

/** A forged value, placed like the scheme's credential. Not a secret, so never redacted. */
export interface Forged {
	kind: "forged"
	schemes: [string]
	sends: SendsByScheme
}

export type Resolution =
	/** The operation's security is `[]` or `{}`, or the actor is anonymous: send nothing. */
	| { kind: "anonymous" }
	/**
	 * No alternative the principal can satisfy, e.g. "no credential for jwt", or a principal's request that
	 * matches no documented operation and names no scheme.
	 */
	| { kind: "unsatisfied"; reason: string }
	/** The principal is BLOCKED for a scheme it needs: its login or refresh failed. */
	| { kind: "blocked"; reason: string }
	| Sending
	| Forged

export interface CredentialSource {
	resolve(request: CredentialRequest): Promise<Resolution>
}

/** A request whose security cannot be met, raised before anything is sent. Callers report it untested or BLOCKED. */
export class UnsatisfiedSecurity extends Error {
	override name = "UnsatisfiedSecurity"
	constructor(
		readonly kind: "unsatisfied" | "blocked",
		readonly reason: string,
	) {
		super(reason)
	}
}

/** A caller, hook or global value under a name the request's credential is placed in: it would override the scheme. */
export class CredentialCollision extends Error {
	override name = "CredentialCollision"
	constructor(
		readonly place: "header" | "query" | "cookie",
		readonly placed: { name: string; scheme: string },
	) {
		super(`${place} "${placed.name}" collides with the ${placed.scheme} credential placement`)
	}
}
