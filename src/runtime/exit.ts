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
	/** The run may have left records behind, whatever else it found, and someone has to look: a
	 * record teardown could not show gone — its delete refused, still listed, never seen by its
	 * creator, or present by `hooks.verifyRemoved` — or a create that answered 2xx with no id oat
	 * could read. An entity with no delete operation alone is a gap, not this. */
	leftovers: 4,
} as const

export type RunOutcome = "clean" | "defects" | "failed" | "leftovers"

/** A finished run as its verdict reads it. */
export interface RunResult {
	findings: ReadonlyArray<{ verdict: string; known?: unknown; operations?: readonly string[] }>
	network?: { incomplete: boolean }
	fenced?: { requests: readonly unknown[]; failRun: boolean }
	scope?: { mode: string; operations: ReadonlyArray<{ operationId?: string; status: string }> }
	/* `unsupported`, an entity with no delete operation, is a gap the run reports; it is not counted here. */
	teardown?: { unidentified: readonly unknown[]; failed?: readonly unknown[]; unsupported?: readonly unknown[] } | null
}

export interface RunVerdict {
	outcome: RunOutcome
	reason: string
}

function leftovers(teardown: RunResult["teardown"]): RunVerdict | undefined {
	const unremoved = teardown?.failed?.length ?? 0
	const unidentified = teardown?.unidentified.length ?? 0
	if (unremoved + unidentified === 0) return undefined
	const kinds = [
		...(unremoved === 0 ? [] : [`${unremoved} teardown could not show gone`]),
		...(unidentified === 0
			? []
			: [`${unidentified} create${unidentified === 1 ? "" : "s"} answered 2xx with no readable id`]),
	]
	return { outcome: "leftovers", reason: `records may remain: ${kinds.join(", ")}` }
}

function cutShort(network: RunResult["network"]): RunVerdict | undefined {
	if (network?.incomplete !== true) return undefined
	return { outcome: "failed", reason: "the network went away before the run finished" }
}

/* What was refused was never tested, so the run did not do what it was asked. */
function fencedOff(fenced: RunResult["fenced"]): RunVerdict | undefined {
	const count = fenced?.requests.length ?? 0
	if (count === 0 || fenced?.failRun !== true) return undefined
	return { outcome: "failed", reason: `${count} request${count === 1 ? " was" : "s were"} fenced` }
}

function nothingGraded(scope: RunResult["scope"]): RunVerdict | undefined {
	if (scope === undefined) return undefined
	if (scope.operations.some((op) => op.status === "passed" || op.status === "failed")) return undefined
	return { outcome: "failed", reason: "no operation was graded, so nothing was proved" }
}

function rootCaused(findings: RunResult["findings"]): RunVerdict | undefined {
	const count = findings.filter(isFailingRootCause).length
	if (count === 0) return undefined
	return { outcome: "defects", reason: `${count} root-cause finding${count === 1 ? "" : "s"}` }
}

/* A target that failed only on findings a baseline names is not a new failure. */
function excused(findings: RunResult["findings"], operationId: string | undefined): boolean {
	if (operationId === undefined) return false
	const naming = findings.filter((finding) => (finding.operations ?? []).includes(operationId))
	return naming.length > 0 && naming.every((finding) => !isFailingRootCause(finding))
}

function targetsMissed(result: RunResult): RunVerdict | undefined {
	if (result.scope?.mode !== "targeted") return undefined
	const { operations } = result.scope
	const failed = operations.filter((op) => op.status === "failed" && !excused(result.findings, op.operationId))
	if (failed.length > 0) return { outcome: "defects", reason: `${failed.length} targeted operation(s) failed` }
	const unjudged = operations.filter((op) => op.status !== "passed")
	if (unjudged.length === 0) return undefined
	return { outcome: "failed", reason: `${unjudged.length} targeted operation(s) were never judged` }
}

/**
 * The verdict on a finished run, and why. Root causes fail it, not raw findings: gaps and blocked
 * entries are information. A run that graded nothing proved nothing, and under `--ops` a target
 * nothing graded must not read as a pass. The exit code and every report state this one verdict.
 */
export function runVerdict(result: RunResult): RunVerdict {
	return (
		leftovers(result.teardown) ??
		cutShort(result.network) ??
		fencedOff(result.fenced) ??
		nothingGraded(result.scope) ??
		rootCaused(result.findings) ??
		targetsMissed(result) ?? { outcome: "clean", reason: "no defects found in what was graded" }
	)
}

/** Exit code for a finished run: {@link runVerdict}, as a number. */
export function exitCode(result: RunResult): number {
	return EXIT[runVerdict(result).outcome]
}
