import { applyBaseline } from "../baseline.ts"
import { type PersistedPrincipal, snapshotPrincipal } from "../principals.ts"
import { buildScopeReport } from "../scope/report.ts"
import { type ScopeReport } from "../scope/types.ts"
import type { TeardownReport } from "../teardown/types.ts"
import type { Planned, RunContext } from "./context.ts"
import type { RunResult } from "./types.ts"

/** What the run graded, per operation, from the transcript and the grades as they stand. */
export function scopeReport({ authCreates, options, findings, grades, model, scope, client }: Planned): ScopeReport {
	return buildScopeReport({
		authCreates,
		baseUrl: options.baseUrl,
		findings: findings.findings,
		inconclusive: findings.inconclusive,
		ledger: grades,
		model,
		scope,
		transcript: client.transcript,
	})
}

/**
 * The run's last requests and writes: credentials refreshed once more, bodies moved out of memory
 * released, the journal flushed. Returns the credentials as they stand, for `principals.json`.
 */
export async function settle(ctx: RunContext): Promise<PersistedPrincipal[]> {
	await ctx.principals.refreshAll("run")
	/* Every check has judged the transcript; bodies moved out of memory are no longer needed. */
	await ctx.client.dispose()
	await ctx.journal?.flush().catch(() => undefined)
	return ctx.principals.all.map((principal) =>
		snapshotPrincipal({
			headers: principal.headers,
			id: principal.id,
			roots: principal.roots,
			...(principal.role === undefined ? {} : { role: principal.role }),
			rank: principal.rank,
			...(principal.inviteAs === undefined ? {} : { inviteAs: principal.inviteAs }),
		}),
	)
}

/** The result of a run the network cut short before any principal could act. */
export async function earlyResult(planned: Planned): Promise<RunResult> {
	await planned.journal?.flush().catch(() => undefined)
	return { ...resultOf(planned), principals: [], scope: scopeReport(planned), teardown: null }
}

/** The result of a run that went the whole way. */
export function finalResult(ctx: RunContext, persisted: PersistedPrincipal[], coverage: ScopeReport): RunResult {
	const { options, findings, state, ledger, targetVersion } = ctx
	const baselined = options.baseline === undefined ? undefined : applyBaseline(findings.findings, options.baseline)
	return {
		...resultOf(ctx),
		...(baselined === undefined ? {} : { baseline: baselined }),
		...(targetVersion === undefined ? {} : { targetVersion }),
		created: ledger.recorded,
		principals: persisted,
		scope: coverage,
		teardown: withUnidentified(state.teardown, ledger.unidentifiedCreates),
		...(state.interrupted ? { interrupted: true } : {}),
	}
}

/** What every result carries, however far the run got. */
function resultOf({ state, findings, client, model, profile, fence, options, journal, network }: Planned) {
	return {
		checkNotes: state.checkNotes,
		checkTimings: state.checkTimings,
		checksOutOfScope: state.checksOutOfScope,
		checksRun: [...state.checksRun].sort(),
		checksSkipped: state.checksSkipped,
		checksSuppressed: state.checksSuppressed,
		client,
		created: 0,
		entitiesTested: state.entitiesTested,
		findings: findings.findings,
		inconclusive: findings.inconclusive,
		model,
		profile: profile.name,
		profileExclusions: state.profileExclusions,
		...(fence === undefined
			? {}
			: { fenced: { failRun: options.fence?.failRun !== false, requests: [...fence.fenced] } }),
		...(journal === null ? {} : { exchanges: { count: journal.count } }),
		...(network.outcome === undefined ? {} : { network: network.outcome }),
	}
}

/* Creates oat could not identify belong in the teardown report even when nothing else was ledgered. */
function withUnidentified(
	teardown: TeardownReport | null,
	unidentified: TeardownReport["unidentified"],
): TeardownReport | null {
	if (unidentified.length === 0) return teardown
	return { ...(teardown ?? { failed: [], records: [], removed: 0, unidentified: [], unsupported: [] }), unidentified }
}
