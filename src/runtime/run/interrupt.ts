import type { RunContext } from "./context.ts"
import type { RunFindingId } from "../check-ids.ts"

/** Whether the run should stop: stopped from outside, or the network is gone for good. */
export function stopped({ options, network }: RunContext): boolean {
	return options.signal?.aborted === true || network.gate.exhausted
}

/** A stop that came after every entity had started still stopped something: say so. */
export function noteLateStop({ options, state, findings, progress }: RunContext): void {
	if (options.signal?.aborted !== true || state.interrupted) return
	state.interrupted = true
	findings.gap(
		"run.interrupted" satisfies RunFindingId,
		"run",
		`stopped during the ${progress.phase} phase`,
		"the run was interrupted; what was tested is reported, and what oat created is removed",
	)
}
