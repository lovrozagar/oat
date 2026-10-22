import { PayloadClaims } from "../checks/families/write/payload-claims.ts"
import type { TeardownReport } from "../teardown/types.ts"
import type { CheckTiming } from "./types.ts"

/**
 * What the run gathers as it goes: which entities and checks ran, skipped, stood down or were
 * suppressed, and how teardown went. Stages add to it; the result reads it once at the end.
 */
export interface RunState {
	entitiesTested: string[]
	checksRun: Set<string>
	checksSkipped: Array<{ check: string; entity: string; needs: string }>
	checksSuppressed: Array<{ check: string; entity: string; because: string }>
	checksOutOfScope: Array<{ check: string; entity: string }>
	checkTimings: CheckTiming[]
	checkNotes: Array<{ check: string; entity: string; note: string }>
	profileExclusions: Array<{ entity: string; operationId: string; reason: string }>
	/** Operations already reported excluded by the profile: each is reported once. */
	excludedIds: Set<string>
	/** Identities each entity's collection is known to hold, filled as its records are ledgered. */
	takenByEntity: Map<string, Set<string>>
	/** What checks compute once is shared run-wide. */
	runMemo: Map<string, unknown>
	/** Which entity runs the whole payload catalog on each write path, shared by every entity in the run. */
	payloadClaims: PayloadClaims
	interrupted: boolean
	teardown: TeardownReport | null
	/** Set once `hooks.verifyRemoved` threw, so the gap is reported once per run. */
	verifyHookFailed: boolean
}

/**
 * The identities `entity`'s records hold, one set for the whole run: what its own lane, the
 * ancestors other lanes make of it, and every 409-refused client-chosen identity add to.
 */
export function takenOf(state: Pick<RunState, "takenByEntity">, entity: string): Set<string> {
	let taken = state.takenByEntity.get(entity)
	if (taken === undefined) {
		taken = new Set()
		state.takenByEntity.set(entity, taken)
	}
	return taken
}

export function emptyState(): RunState {
	return {
		checkNotes: [],
		checkTimings: [],
		checksOutOfScope: [],
		checksRun: new Set(),
		checksSkipped: [],
		checksSuppressed: [],
		entitiesTested: [],
		excludedIds: new Set(),
		interrupted: false,
		payloadClaims: new PayloadClaims(),
		profileExclusions: [],
		runMemo: new Map(),
		takenByEntity: new Map(),
		teardown: null,
		verifyHookFailed: false,
	}
}
