/* One check: what it needs, which operations it grades, and how it runs. */

import type { CheckId } from "../../check-ids.ts"
import type { CheckContext, Listed, WriteContext } from "./context.ts"
import type { OperationContext, OperationWriteContext } from "./operation-context.ts"
import type { Plan } from "./plan.ts"
import type { Outcome } from "../../finding.ts"
import type { EntityModel, SpecModel } from "../../../spec/graph/types.ts"
import type { Client } from "../../../client/client.ts"

export interface CheckBase<T, X extends CheckContext = CheckContext> {
	id: CheckId
	/** What the check is planned on: an entity and its cohort. The default; see `OperationCheck`. */
	subject?: "entity"
	/** Decides whether the check applies to this entity, and gathers what `run` needs if it does. */
	plan(ctx: X): Plan<T>
	/**
	 * Check ids whose failure makes this one's result meaningless. When any has already fired for
	 * this entity, the check is skipped rather than reporting a consequence as a separate defect —
	 * one root cause should produce one finding, not a page of them.
	 */
	dependsOn?: CheckId[]
	/**
	 * Whether the check judges traffic other checks sent. It runs after every check before it has
	 * finished, never alongside them, so it cannot miss what its batch-mates were still sending.
	 */
	judgesTranscript?: boolean
	/**
	 * What this check needs in order to run at all, in the reader's terms.
	 *
	 * Reported when the plan cannot run. Skipping silently would leave someone on an API
	 * shaped differently from the fixture believing a quiet run meant a clean one, when in truth
	 * half the suite never fired.
	 */
	needs?: string
	/**
	 * Operations whose contract this check judges, decided from the entity graph alone.
	 *
	 * Static so `oat plan --ops` can show a scope without a network, and so a targeted run can
	 * queue only the entities whose checks grade a target. Every other operation a check calls is
	 * support: needed to reach or observe a subject, never graded itself. Required, so a new check
	 * cannot run invisibly under `--ops`.
	 */
	subjects: (entity: EntityModel, model: SpecModel) => string[]
}

/**
 * Whether the check changes server state. Mutating checks run alone and in order, with a client
 * that can write; read-only checks batch together, with one that cannot. Two writers racing on
 * the same cohort would make each other's observations wrong, and the resulting finding would
 * describe the interference rather than the backend.
 */
type Runs<T, R, W> =
	| { mutates: true; run(ctx: W, plan: T): Promise<Outcome> }
	| { mutates?: false; run(ctx: R, plan: T): Promise<Outcome> }

/** A check that needs no list: it plans and runs on every entity, listed or not. */
export type UnlistedCheck<T = unknown> = CheckBase<T> & { lists?: false } & Runs<T, CheckContext, WriteContext>

/**
 * A check that reads the entity's listing: it plans and runs only where the entity has a list
 * operation, with `listOp` set. On an entity with none it is skipped as needing one, never run.
 */
export type ListingCheck<T = unknown> = CheckBase<T, Listed> & { lists: true } & Runs<T, Listed, Listed<Client>>

/** An entity check: one that needs no list, or one that reads the entity's listing. */
export type Check<T = unknown> = UnlistedCheck<T> | ListingCheck<T>

/**
 * A check planned on one operation rather than on an entity: the security family's. The security
 * stage (run/security.ts) schedules each probe, the check on one operation, by its placement
 * (`placementOf`): a collection read before the entity lanes, concurrently; a read of one record
 * after them, concurrently, on a record the run created (`ctx.target`); a write, or any probe of a
 * check that changes a credential, after them alone and in order. `mutates` says only that some
 * probe of the check writes, which types its client. Findings are attributed to the operation.
 */
export interface OperationCheckBase<T> {
	id: CheckId
	subject: "operation"
	/** Decides whether the check applies to this operation, and gathers what `run` needs if it does. */
	plan(ctx: OperationContext): Plan<T>
	/** What the check needs in order to run at all, in the reader's terms; see `CheckBase.needs`. */
	needs?: string
	/** Planned only when the config's `checks` switches it on; otherwise skipped, saying how to opt in. */
	optIn?: true
	/**
	 * The check changes a credential (revokes it, rotates it, spends a login's attempts): every one of
	 * its probes runs after the lanes, alone and in order, whatever its method.
	 */
	mutatesCredentials?: true
}

/** An operation check, by whether it changes server state or a credential: see `Check`. */
export type OperationCheck<T = unknown> = OperationCheckBase<T> &
	(
		| { mutates: true; run(ctx: OperationWriteContext, plan: T): Promise<Outcome> }
		| { mutates?: false; run(ctx: OperationContext, plan: T): Promise<Outcome> }
	)

/** What the registry holds: entity checks and operation checks, in one list, in run order. */
export type RegisteredCheck = Check | OperationCheck
