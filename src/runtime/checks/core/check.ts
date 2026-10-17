/* One check: what it needs, which operations it grades, and how it runs. */

import type { CheckId } from "../../check-ids.ts"
import type { CheckContext, WriteContext } from "./context.ts"
import type { Plan } from "./plan.ts"
import type { Outcome } from "../../finding.ts"
import type { EntityModel, SpecModel } from "../../../spec/graph.ts"

export interface CheckBase<T> {
	id: CheckId
	/** Decides whether the check applies to this entity, and gathers what `run` needs if it does. */
	plan(ctx: CheckContext): Plan<T>
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
export type Check<T = unknown> = CheckBase<T> &
	(
		| { mutates: true; run(ctx: WriteContext, plan: T): Promise<Outcome> }
		| { mutates?: false; run(ctx: CheckContext, plan: T): Promise<Outcome> }
	)
