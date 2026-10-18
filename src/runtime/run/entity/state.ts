import type { EntityModel, OperationModel } from "../../../spec/graph/types.ts"
import type { Client } from "../../../client/client.ts"
import type { FindingCollector } from "../../finding.ts"
import type { Record_ } from "../../world/records.ts"
import type { AncestorCache, Scope } from "../../world/types.ts"
import type { RunContext } from "../context.ts"

/** One entity under test: what it is, and what its seeding has learned so far. */
export interface EntityRun {
	ctx: RunContext
	entity: EntityModel
	/** The entity's place in the model: half of what keeps one check run's salts its own. */
	index: number
	listOp: OperationModel
	createOp: OperationModel | undefined
	/** Findings about seeding land on the targets this entity's checks grade. */
	findings: FindingCollector
	/** Every configured root, then the first principal's own. */
	roots: Record<string, string>
	/** Everything this entity's world-building sends is seeding, attributed to the entity. */
	seeding: Client
	/**
	 * This entity's own scratch parents, shared by its records and its principals' scopes but by
	 * no other entity: entities whose parent chains are disjoint run side by side, and one that
	 * shares a parent record with another could see that entity's writes through it.
	 */
	ancestors: AncestorCache
	/** Identities this entity's collection is known to hold; no create oat sends may reuse one. */
	taken: Set<string>
	/**
	 * Cohort variants the backend refused. A check that stands down for want of cohort data says
	 * which variants never arrived, so the gap points at the seed rather than the API.
	 */
	lostVariants: string[]
}

/** The records the entity's checks run against, and what oat knows about them. */
export interface World {
	scope: Scope
	records: Record_[]
	/** Records oat did not write: every write-path check sits out rather than assert against them. */
	degraded: boolean
	/** Adopted after a unique conflict: the unique-conflict checks still run against the row. */
	uniqueAdopted: boolean
	/** The create answered with an acknowledgement rather than the record. */
	createAcknowledged: boolean
}

/** A world of records oat did not create: read from what the list already returns. */
export function degradedWorld(existing: { records: Record_[]; scope: Record<string, string> }): World {
	return {
		createAcknowledged: false,
		degraded: true,
		records: existing.records,
		scope: { created: [], values: existing.scope },
		uniqueAdopted: false,
	}
}
