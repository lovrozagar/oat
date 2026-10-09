/** Process exit codes for a run, shared by the CLI and anyone embedding oat. */

import { isRootCause } from "./finding.ts"

/** What the process exit code says. Defects found and oat failing are different answers. */
export const EXIT = {
	/** Every graded operation held. */
	clean: 0,
	/** At least one root-cause finding — or, under `--ops`, a target that failed. */
	defects: 1,
	/** The command line or config was wrong; nothing ran. */
	usage: 2,
	/** oat could not do what it was asked: the network went away, nothing was graded, a target
	 * was never judged, or oat itself threw. */
	failed: 3,
} as const

export type RunOutcome = "clean" | "defects" | "failed"

/**
 * The verdict on a finished run, and why. Root causes fail it, not raw findings: gaps and blocked
 * entries are information. A run that graded nothing proved nothing, and under `--ops` a target
 * nothing graded must not read as a pass. The exit code and every report state this one verdict.
 */
export function runVerdict(result: {
	findings: ReadonlyArray<{ verdict: string }>
	network?: { incomplete: boolean }
	scope?: { mode: string; operations: ReadonlyArray<{ operationId?: string; status: string }> }
}): { outcome: RunOutcome; reason: string } {
	if (result.network?.incomplete === true) {
		return { outcome: "failed", reason: "the network went away before the run finished" }
	}
	const rootCauses = result.findings.filter(isRootCause).length
	if (result.scope !== undefined) {
		const graded = result.scope.operations.filter((op) => op.status === "held" || op.status === "failed")
		if (graded.length === 0) return { outcome: "failed", reason: "no operation was graded, so nothing was proved" }
	}
	if (rootCauses > 0) {
		return { outcome: "defects", reason: `${rootCauses} root-cause finding${rootCauses === 1 ? "" : "s"}` }
	}
	if (result.scope?.mode === "targeted") {
		const failed = result.scope.operations.filter((op) => op.status === "failed")
		if (failed.length > 0) return { outcome: "defects", reason: `${failed.length} targeted operation(s) failed` }
		const unjudged = result.scope.operations.filter((op) => op.status !== "held")
		if (unjudged.length > 0) {
			return { outcome: "failed", reason: `${unjudged.length} targeted operation(s) were never judged` }
		}
	}
	return { outcome: "clean", reason: "no defects found in what was graded" }
}

/** Exit code for a finished run: {@link runVerdict}, as a number. */
export function exitCode(result: Parameters<typeof runVerdict>[0]): number {
	return EXIT[runVerdict(result).outcome]
}
