/* What an operation check runs against: one operation, the principals, and the run's probe credentials. */

import type { Client, ReadClient } from "../../../client/client.ts"
import type { CheckSwitches } from "../../../config/types/config.ts"
import type { FindingCollector } from "../../finding.ts"
import type { OperationModel, SpecModel } from "../../../spec/graph/types.ts"
import type { ResolvedSecurity } from "../../../spec/security/requirements.ts"
import type { RecipeAnchors } from "../../../credentials/anchors.ts"
import type { Actor } from "./context.ts"

/**
 * The record a write probe may send to: one the run created, read back just now, so it exists. A
 * mutating check's client refuses a write to any other path. Its body should be harmless if the
 * backend applied it: the record's `current` state, or the lane's own valid update.
 */
export interface WriteTarget {
	entity: string
	id: string
	/** The principal that created it. */
	owner: string
	/** Every path parameter of the operation, filled for this record. */
	params: Readonly<Record<string, string>>
	/** The operation's path filled for this record, below the base URL: the only path a write may go to. */
	path: string
	/** The record as its creator just read it. */
	current: unknown
}

/** How a dedicated credential's reused refresh went: refused, as it must be, or accepted. */
export type Replayed = { accepted: true } | { accepted: false; reason: string }

/** A dedicated session after its recipe's refresh rotated it. */
export interface Rotation {
	/** The value the rotation issued, which the actor now sends. */
	value: string
	/** Runs the refresh again from before the rotation: the rotated refresh token, reused. */
	replay(): Promise<Replayed>
}

/**
 * A credential acquired for a probe alone: a second login, a fresh mint, a new token grant. Never the
 * principal's own session, so revoking or rotating it leaves the run's principals untouched. It is
 * revoked at teardown when its recipe declares how.
 */
export interface DedicatedCredential {
	/** Sends it: `as: actor`. The principal is `<owner>#probe-<n>`; never name it in a finding. */
	actor: { principal: string }
	/** The principal it was acquired for, the one a finding names. */
	owner: string
	scheme: string
	value: string
	/** Revokes it through the declared path (a mint's `revoke`, a login's `revoke`); absent without one. */
	revoke?: () => Promise<void>
	/** Rotates it by the recipe's declared refresh; absent without one. */
	rotate?: () => Promise<Rotation>
}

/** A credential a probe asked for, or why it cannot have one: the check is untested with that reason. */
export type Probed<T> = T | { untested: string }

/** What a probe asks for: whose credential, for which scheme, carrying which scopes. */
export interface ProbeRequest {
	principal: string
	scheme: string
	scopes?: readonly string[]
	/**
	 * The probe never spends the credential (no revoke, no rotation): one per principal, scheme and
	 * scope set serves every such probe of the run. A probe that spends it asks without this.
	 */
	reusable?: true
}

/** The credentials an operation check may probe with, beyond sending `as` a principal. */
export interface ProbeCredentials {
	/** A credential of the principal's own for a probe alone. Static and hook recipes cannot issue one. */
	dedicated(request: ProbeRequest): Promise<Probed<DedicatedCredential>>
	/**
	 * The value the principal's own credential holds for the scheme, to derive a forged one from: send
	 * that as `{ forged: { scheme, value, derived: true } }`, which redacts it like the credential.
	 */
	held(request: ProbeRequest): Promise<Probed<{ value: string }>>
	/**
	 * The principal's effective recipe for the scheme: its kind, and the operations that issue,
	 * refresh and revoke its credential, each when the document declares it. Synchronous, so a plan
	 * can anchor on it: a probe of issuing, revoking or refreshing runs once per scheme, there.
	 */
	recipe(request: { principal: string; scheme: string }): Probed<RecipeAnchors>
}

/** Where a probe runs: see `placementOf`. */
export type ProbePlacement = "read" | "item-read" | "write"

/**
 * What an operation check runs against, for one probe. A `read` or `item-read` probe gets a client
 * that cannot write; a `write` probe one that can.
 */
export interface OperationContext<C extends ReadClient = ReadClient> {
	operation: OperationModel
	model: SpecModel
	client: C
	/** Attributed to the operation, and owned by the check. */
	findings: FindingCollector
	/** What a finding names as its entity: the operation's id. */
	subject: string
	/** The principal checks act as: the first. */
	actor: Actor
	/** The first principal of a tenant other than the actor's, when one is configured. */
	peer?: Actor
	/** Every principal the run signed in, `actor` first. A dedicated credential's probe principal is never one. */
	principals: Actor[]
	/** The operation's security, as the document resolves it. */
	security: ResolvedSecurity
	probe: ProbeCredentials
	options: { checks: CheckSwitches }
	/** Where this probe runs, which decides its client and whether it has a `target`. */
	placement: ProbePlacement
	/** The run's nonce: what keeps a probe's made-up values, an address that cannot exist, the run's own. */
	nonce: string
	/**
	 * For an `item-read` or `write` probe: a record this run created, read back, to send to. Absent
	 * when the run created none of the operation's entity, or the operation names no single record;
	 * `targetPlan` then stands the check down with the reason. A DELETE probe's target is a throwaway
	 * record of its own, never one another step uses.
	 */
	target?: WriteTarget
	/** Why there is no `target`, when the run knows better than that it created none: `targetPlan` names it. */
	untargeted?: string
}

/** The context of an operation check that changes server state or a credential. */
export type OperationWriteContext = OperationContext<Client>
