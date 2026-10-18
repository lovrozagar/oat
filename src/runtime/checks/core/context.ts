/* What a check runs against: the entity, its operations, the clients and every principal. */

import type { PayloadPolicy } from "../../../config/types/config.ts"
import type { Hooks } from "../../../config/types/hooks.ts"
import type { Client, ReadClient } from "../../../client/client.ts"
import type { Exchange } from "../../exchange.ts"
import type { FindingCollector } from "../../finding.ts"
import type { BackoffConfig } from "../../poll.ts"
import type { Created } from "../../teardown/types.ts"
import type { UploadContext } from "../../upload.ts"
import type { SchemaValidator } from "../../validate.ts"
import type { Record_ } from "../../world/records.ts"
import type { InviteSpec } from "../../../spec/extensions/invite.ts"
import type { QueryCapability } from "../../../spec/extensions/query-tag.ts"
import type { OperationModel, SpecModel } from "../../../spec/graph/types.ts"
import type { EffectiveQueryCapabilities } from "../../../spec/query/effective.ts"

/** A resolved principal as checks see it — identity, lattice position, and how to speak as it. */
export interface Actor {
	id: string
	role: string | undefined
	/** Higher can do everything a lower rank can. Same rank = peers. */
	rank: number
	headers: () => Record<string, string>
	/**
	 * Replace this actor's credential after a response issues a new one.
	 * Static principals and auth flows both implement it. Absent means the actor cannot.
	 */
	adoptCredential?: (token: string) => void
	/** Tenant identity from config / the auth flow — not the full path scope. */
	roots: Record<string, string>
	scope: Record<string, string>
	/** Value the owner puts in an invite body for this principal. */
	inviteAs: string | undefined
}

/**
 * What checks compute once and share. `run` holds answers that stay true for the whole run, such as
 * a set read keyed by request and write count; `entity` holds facts about one entity's seeded
 * cohort. Keys are namespaced by the asker. A run makes one `run` map and a fresh `entity` map per
 * entity, so nothing outlives the run that made it.
 */
export interface CheckMemo {
	run: Map<string, unknown>
	entity: Map<string, unknown>
}

/** A memo for one entity; pass the run's `run` map to share answers across entities. */
export function checkMemo(run: Map<string, unknown> = new Map()): CheckMemo {
	return { entity: new Map(), run }
}

/**
 * What a check runs against. A check that does not mutate gets a client that cannot write; a
 * helper that writes asks for a `WriteContext`, so a read-only check calling it does not compile.
 */
export interface CheckContext<C extends ReadClient = ReadClient> {
	entityName: string
	identity: string
	model: SpecModel
	client: C
	findings: FindingCollector
	scope: Record<string, string>
	listOp: OperationModel
	readOp: OperationModel | undefined
	createOp: OperationModel | undefined
	updateOp: OperationModel | undefined
	deleteOp: OperationModel | undefined
	collectionKey: string | null
	records: Record_[]
	query: QueryCapability | null
	/** Merged filter catalog. Optional so a hand-built context still works. */
	capabilities?: EffectiveQueryCapabilities
	softDelete: string | null
	invite: InviteSpec | null
	auth: () => Record<string, string>
	/** Countdown / 401 refresh for the writer principal. Bound onto the client as well. */
	refreshIfStale?: (force?: boolean) => Promise<void>
	/**
	 * Every configured principal, primary first. Isolation checks still use `altAuth` (the first
	 * actor whose scope is a different tenant). Lattice checks walk this list by `rank`.
	 */
	actors: Actor[]
	/** Principal in a different tenant, when one is configured. Derived, not `principals[1]`. */
	altAuth: (() => Record<string, string>) | undefined
	altScope: Record<string, string> | undefined
	validator: SchemaValidator | undefined
	seed: number
	/** Per-run token for values that must not collide across runs: unique columns, idempotency keys. */
	nonce: string
	/**
	 * A salt for the next body this check makes: distinct within the run, and the same in every run
	 * with the same inputs — never drawn from what other checks did meanwhile.
	 */
	nextSalt?: () => string
	/** Effective unique column sets for this entity (`[]` when the tag is absent or empty). */
	uniqueSets: string[][]
	/** First-variant create 409 adopted a same-tenant row; unique probes still run. */
	uniqueAdopted: boolean
	/** The create acknowledged without the record; the records are the bodies oat submitted. */
	createAcknowledged: boolean
	/** Identities the collection is known to hold: a body oat generates never names one. */
	takenIdentities?: Set<string>
	/** Create operation for unique probes — still set after unique-409 adopt. */
	uniqueCreateOp: OperationModel | undefined
	/** Update operation for unique probes — still set after unique-409 adopt. */
	uniqueUpdateOp: OperationModel | undefined
	/** File pool / dummy resolution for multipart parts. */
	uploads: UploadContext
	/** Operations on this entity declared async via `x-async`. */
	asyncOps: OperationModel[]
	/** Operations on this entity that declare `x-effects`. */
	effectOps: OperationModel[]
	/** Operations on this entity that declare `x-wait`. */
	waitOps: OperationModel[]
	hooks: Hooks
	outOfBand: BackoffConfig
	/**
	 * The payload policy, and the write paths that have had the whole catalog this run — keyed
	 * by media type and field type, naming the entity that ran it. Optional so a hand-built
	 * context still works; absent means the whole catalog.
	 */
	payloads?: { policy: PayloadPolicy; ran: Map<string, string> }
	/**
	 * Whether an operation is graded by this run. Always true on a full run. Checks that judge
	 * several operations consult it before invoking or judging one. Optional so a hand-built
	 * context still works.
	 */
	inScope?: (op: OperationModel) => boolean
	/**
	 * Registers a record this check caused to exist — a declared effect, a started job — for
	 * teardown. Records made through the entity's own create are tracked without it.
	 */
	/** Ledgers a record made other than by its create, as the principal that sent the request. */
	recordCreated?: (created: Created, principal?: string) => void
	/** A create that answered 2xx with no id oat could read: the record may remain. */
	recordUnidentified?: (entity: string, operationId: string, exchange: Exchange) => void
	/** A ledgered record an accepted write moved, so its creator's 404 no longer shows it gone. */
	recordMoved?: (entity: string, id: string, reason: string) => void
	/**
	 * Narrows what this check graded to the operations it actually judged. A check that judges
	 * after the fact — from whatever the transcript happens to hold — calls it, so an operation
	 * nothing ever exercised is not reported as passed. Checks that invoke their subjects need not.
	 */
	judged?: (operationIds: readonly string[]) => void
	/** Computed once, shared by the checks that ask: see `CheckMemo`. */
	memo: CheckMemo
}

/** The context of a check that changes server state. */
export type WriteContext = CheckContext<Client>
