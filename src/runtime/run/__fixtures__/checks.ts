import type { CheckId } from "../../check-ids.ts"
import type { CheckContext } from "../../checks/core/context.ts"
import type { Plan } from "../../checks/core/plan.ts"
import type { Outcome } from "../../finding.ts"
import { actorsOf } from "../entity/actors.ts"
import { checkContext } from "../entity/check-context.ts"
import type { Check, CheckLoop } from "../entity/run-check.ts"
import type { World } from "../entity/state.ts"
import type { RunContext } from "../context.ts"
import { entityRunOf } from "./api.ts"

/* Checks made for the loop's tests: each says what it plans, what it depends on, and how it ends. */

export interface CheckSpec {
	id: string
	run?: (ctx: CheckContext) => Promise<Outcome>
	plan?: Plan<unknown>
	dependsOn?: string[]
	mutates?: boolean
	judgesTranscript?: boolean
	needs?: string
	/** The operations it grades on the entity. */
	subjects?: string[]
}

/** A check as the registry would hold it. Ids are free text here: the loop only compares them. */
export function checkOf(spec: CheckSpec): Check {
	return {
		id: spec.id as CheckId,
		plan: () => spec.plan ?? { ok: true, value: spec.id },
		run: spec.run ?? (async () => ({ kind: "asserted" })),
		subjects: () => spec.subjects ?? ["notes.list"],
		...(spec.dependsOn === undefined ? {} : { dependsOn: spec.dependsOn as CheckId[] }),
		...(spec.mutates === undefined ? {} : { mutates: spec.mutates }),
		...(spec.judgesTranscript === undefined ? {} : { judgesTranscript: spec.judgesTranscript }),
		...(spec.needs === undefined ? {} : { needs: spec.needs }),
	} as unknown as Check
}

export const FRESH: World = {
	createAcknowledged: false,
	degraded: false,
	records: [{ id: "n1", title: "a" }],
	scope: { created: [], values: {} },
	uniqueAdopted: false,
}

/** A loop over the notes entity of `ctx`, before any check ran. */
export async function loopOf(ctx: RunContext, world: World = FRESH): Promise<CheckLoop> {
	const run = entityRunOf(ctx)
	return {
		context: await checkContext(run, world, await actorsOf(run, world)),
		outcomes: new Map(),
		plans: new Map(),
		run,
	}
}
