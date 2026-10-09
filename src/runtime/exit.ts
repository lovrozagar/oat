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

/**
 * Exit code for a finished run. Root causes fail it, not raw findings: gaps and blocked entries
 * are information. A run that graded nothing proved nothing, and under `--ops` a target nothing
 * graded must not read as a pass.
 */
export function exitCode(result: {
	findings: ReadonlyArray<{ verdict: string }>
	network?: { incomplete: boolean }
	scope: { mode: string; operations: ReadonlyArray<{ status: string }> }
}): number {
	if (result.network?.incomplete === true) return EXIT.failed
	const graded = result.scope.operations.filter((op) => op.status === "held" || op.status === "failed")
	if (graded.length === 0) return EXIT.failed
	if (result.findings.some(isRootCause)) return EXIT.defects
	if (result.scope.mode === "targeted") {
		if (result.scope.operations.some((op) => op.status === "failed")) return EXIT.defects
		if (result.scope.operations.some((op) => op.status !== "held")) return EXIT.failed
	}
	return EXIT.clean
}
