/** Process exit codes for a run, shared by the CLI and anyone embedding oat. */

import { isFailingRootCause } from "./finding.ts"

/** What the process exit code says. Defects found and oat failing are different answers. */
export const EXIT = {
	/** Every graded operation passed. */
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
	findings: ReadonlyArray<{ verdict: string; known?: unknown; operations?: readonly string[] }>
	network?: { incomplete: boolean }
	fenced?: { requests: readonly unknown[]; failRun: boolean }
	scope?: { mode: string; operations: ReadonlyArray<{ operationId?: string; status: string }> }
}): { outcome: RunOutcome; reason: string } {
	if (result.network?.incomplete === true) {
		return { outcome: "failed", reason: "the network went away before the run finished" }
	}
	/* What was refused was never tested, so the run did not do what it was asked. */
	const fenced = result.fenced?.requests.length ?? 0
	if (fenced > 0 && result.fenced?.failRun === true) {
		return { outcome: "failed", reason: `${fenced} request${fenced === 1 ? " was" : "s were"} fenced` }
	}
	const rootCauses = result.findings.filter(isFailingRootCause).length
	if (result.scope !== undefined) {
		const graded = result.scope.operations.filter((op) => op.status === "passed" || op.status === "failed")
		if (graded.length === 0) return { outcome: "failed", reason: "no operation was graded, so nothing was proved" }
	}
	if (rootCauses > 0) {
		return { outcome: "defects", reason: `${rootCauses} root-cause finding${rootCauses === 1 ? "" : "s"}` }
	}
	if (result.scope?.mode === "targeted") {
		/* A target that failed only on findings a baseline names is not a new failure. */
		const excused = (operationId: string | undefined): boolean => {
			const naming = result.findings.filter(
				(finding) => operationId !== undefined && (finding.operations ?? []).includes(operationId),
			)
			return naming.length > 0 && naming.every((finding) => !isFailingRootCause(finding))
		}
		const failed = result.scope.operations.filter((op) => op.status === "failed" && !excused(op.operationId))
		if (failed.length > 0) return { outcome: "defects", reason: `${failed.length} targeted operation(s) failed` }
		const unjudged = result.scope.operations.filter((op) => op.status !== "passed")
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
