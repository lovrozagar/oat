/** What seeding the world works with: the options a run gives it, the scope it builds, the cohort it makes. */

import type { Client } from "../../client/client.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import type { CohortMember } from "../fixture.ts"
import type { ProvenId } from "../proven-id.ts"
import type { UploadContext } from "../upload.ts"
import type { Record_ } from "./records.ts"

export interface Scope {
	values: Record<string, string>
	/** Records created while resolving ancestors, newest last — unwound in reverse at teardown. */
	created: Array<{ entity: string; path: string; id: string }>
}

/** Ancestors made in this run, and those whose create is under way, by principal, operation and parent path. */
export interface AncestorCache {
	made: Map<string, string>
	/** Entities in parallel lanes can reach the same missing ancestor at once; the second waits here. */
	creating: Map<string, Promise<string>>
}

export interface WorldOptions {
	roots: Record<string, string>
	seed: number
	/**
	 * Per-run token mixed into every value that must not collide with an earlier run's records —
	 * unique columns, above all. A seed alone repeats exactly, which is its job.
	 */
	nonce?: string
	cohortSize?: number
	authHeaders: () => Record<string, string>
	uploads?: UploadContext
	/**
	 * Called the moment a record exists, before anything else can fail. A record learned about
	 * only after the step that made it returns is dropped whenever a later step throws.
	 */
	onCreate?: (entity: string, id: ProvenId, scope: Record<string, string>) => void
	/** Called for a create that answered 2xx with no id oat could read: the record may remain. */
	onUnidentified?: (entity: string, operationId: string, exchange: Exchange) => void
	/** Whether oat may call an operation (a profile can exclude one); omitted means every one. */
	readable?: (op: OperationModel) => boolean
	/** Who is creating — keys the ancestor cache, since one principal's parent is not another's. */
	principal?: string
	/** Ancestors already made in this run, by principal, operation and parent path. */
	ancestors?: AncestorCache
}

/** Where seeding happens: the model, the client it sends through, and the run's options. */
export interface Seeding {
	model: SpecModel
	client: Client
	options: WorldOptions
}

export interface SeededCohort {
	members: CohortMember[]
	records: Record_[]
	/** Identities the collection held before seeding, as listed: no later create may reuse one. */
	existingIds?: string[]
	/**
	 * Set when the first (or only) create was a documented feature-gate 403.
	 *
	 * Not an error: the document said this principal cannot create the row. The run degrades
	 * the same way a profile-excluded create does.
	 */
	featureGate: { key: string; detail: string; exchange: Exchange } | null
	/**
	 * Create hit a documented plan limit and these records were adopted from the list / an
	 * earlier effect. Write-path checks must stand down — oat did not submit these bodies.
	 */
	adopted?: boolean
	/**
	 * First-variant create returned 409 on an `x-unique` operation and a same-tenant row was
	 * adopted. Unique-conflict checks still run; write-path oracles that need oat's submitted
	 * seed body stay skipped.
	 */
	uniqueAdopted?: boolean
	/**
	 * The create answered an acknowledgement without the record, and the records are the bodies
	 * oat submitted (client-chosen identity). Checks that judge the create's echo stand down.
	 */
	acknowledged?: boolean
	/** Set when extra cohort variants were dropped because unique values could not differ. */
	uniqueGap?: string
	/**
	 * Variants after the first whose create failed. The cohort carries on without them, and the
	 * run reports each: a 5xx is the backend's failure, a 4xx a variant the document permits and
	 * the backend refused.
	 */
	failedVariants?: Array<{ variant: string; exchange: Exchange }>
}
