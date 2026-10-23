import { accountReport } from "./accounts.ts"
import { applyBaseline } from "../baseline.ts"
import { type KeptCredential, keptCredentials, type PersistedPrincipal, snapshotPrincipal } from "../principals.ts"
import { buildScopeReport } from "../scope/report.ts"
import { type ScopeReport } from "../scope/types.ts"
import type { TeardownReport } from "../teardown/types.ts"
import type { Planned, RunContext } from "./context.ts"
import { runPrincipal } from "./principals.ts"
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

/** The principals as the run leaves them, and with `keepCredentials` the values they held. */
export interface Settled {
	principals: PersistedPrincipal[]
	credentials?: KeptCredential[]
}

/**
 * The run's last writes: the journal flushed. Returns the principals as they stand for
 * `principals.json`, the BLOCKED ones with why, holding no credential
 * value; the values come back only when the run was asked to keep them.
 */
export async function settle(ctx: RunContext): Promise<Settled> {
	await ctx.journal?.flush().catch(() => undefined)
	const { principals, store, client } = ctx
	const held = await store.snapshot()
	/* A BLOCKED principal is kept too, with why: a persisted run says who it went on without. */
	const blocked = principals.blocked.map(({ id, reason }) => ({ ...runPrincipal(store, id), blocked: reason }))
	return {
		principals: [...principals.all, ...blocked].map((principal) =>
			snapshotPrincipal(principal, { held, redactor: client.redactor }),
		),
		...(ctx.options.keepCredentials === true ? { credentials: keptCredentials(held) } : {}),
	}
}

/** The result of a run the network cut short before any principal could act. */
export async function earlyResult(planned: Planned): Promise<RunResult> {
	await planned.journal?.flush().catch(() => undefined)
	/* Accounts its principals' sign-ups made before it stopped: nothing removes them now. */
	const accounts = planned.accounts.owed()
	for (const entry of accounts) {
		planned.accounts.settle(entry, { note: "the run stopped before teardown", status: "left" })
	}
	return {
		...resultOf(planned),
		created: accounts.length,
		principals: [],
		scope: scopeReport(planned),
		teardown: accounts.length === 0 ? null : accountReport(accounts),
	}
}

/** The result of a run that went the whole way. */
export function finalResult(ctx: RunContext, settled: Settled, coverage: ScopeReport): RunResult {
	const { options, findings, state, ledger, targetVersion } = ctx
	const baselined = options.baseline === undefined ? undefined : applyBaseline(findings.findings, options.baseline)
	return {
		...resultOf(ctx),
		...(baselined === undefined ? {} : { baseline: baselined }),
		...(targetVersion === undefined ? {} : { targetVersion }),
		created: ledger.recorded + ctx.accounts.entries().filter((entry) => entry.status !== "refused").length,
		principals: settled.principals,
		...(settled.credentials === undefined ? {} : { credentials: settled.credentials }),
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
