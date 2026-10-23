import { teardownAccounts } from "./accounts.ts"
import { buildRegistry } from "../checks/core/define.ts"
import { CHECKS } from "../checks/registry.ts"
import { connect, disposeClients } from "./client-setup.ts"
import type { Connected, RunContext } from "./context.ts"
import { contractFloor } from "./contract-floor.ts"
import { disposable } from "./disposable.ts"
import { errorText } from "./errors.ts"
import { createExclusion } from "./exclusion.ts"
import { noteLateStop } from "./interrupt.ts"
import { runLanes } from "./lanes.ts"
import { runReadSecurity, runWriteSecurity } from "./security.ts"
import { load } from "./load.ts"
import { type OriginRuns, runSecondaryOrigins } from "./origins.ts"
import { resolvePrincipals } from "./principals.ts"
import { publicGets } from "./public-gets.ts"
import { earlyResult, finalResult, scopeReport, settle } from "./result.ts"
import { scenarios } from "./scenarios.ts"
import { planScope } from "./scope-plan.ts"
import { serverErrors } from "./server-errors.ts"
import { readVersion } from "./target-version.ts"
import { reportUnremovable, revokeCredentials, revokeSessions, trackCreates, unwind } from "./teardown.ts"
import type { RunOptions, RunResult } from "./types.ts"
import type { RunFindingId } from "../check-ids.ts"

/**
 * Run orchestrator: model → world → checks → findings.
 *
 * The world is seeded once and outlives every check. A seeding failure is recorded once and
 * everything downstream is reported BLOCKED against that single cause, rather than re-failing per
 * case. The matrix's fixtures go before the scenarios: a scenario sets its own scene, and a record
 * a check left (a pending invite) would refuse the scenario's own as a duplicate.
 */
export async function run(options: RunOptions): Promise<RunResult> {
	/* A registry with a duplicate id or a dependency out of order would grade nothing correctly. */
	buildRegistry(CHECKS)
	const connected = connect(await load(options))
	/* However the run ends (done, stopped or thrown), no client's spooled bodies stay on disk. */
	try {
		return await runConnected(connected)
	} finally {
		await disposeClients(connected)
	}
}

async function runConnected(connected: Connected): Promise<RunResult> {
	const planned = planScope(connected)
	const principals = await resolvePrincipals(planned)
	if (principals === null) return earlyResult(planned)
	const authed = { ...planned, principals }
	const ctx: RunContext = { ...authed, exclusion: createExclusion(authed), targetVersion: await readVersion(authed) }
	trackCreates(ctx)
	await publicGets(ctx)
	/* Read-only security probes before the lanes; the write and mutating ones after, while the
	 * records the lanes and disposable sessions created are still there to be targeted. */
	await runReadSecurity(ctx)
	await runLanes(ctx)
	await disposable(ctx)
	await runWriteSecurity(ctx)
	await unwind(ctx)
	await scenarios(ctx)
	await contractFloor(ctx)
	noteLateStop(ctx)
	/* What scenarios and contract calls created since. */
	await unwind(ctx)
	serverErrors(ctx)
	reportUnremovable(ctx)
	const settled = await settle(ctx)
	const coverage = scopeReport(ctx)
	await closeOut(ctx, { coverage, runOrigin: run })
	ctx.progress.tick({ message: "done", phase: "done", requests: ctx.progress.requests })
	return finalResult(ctx, settled, coverage)
}

/**
 * The run's last calls, in this order: the secondary origins, which send its minted keys too; then
 * the revokes of every key minted; then the accounts it signed up, whose sessions those revokes
 * were sent with; and last, the configured principals' own sessions, where the login declares how.
 */
export async function closeOut(ctx: RunContext, runs: OriginRuns): Promise<void> {
	const { options } = ctx
	if ((options.origins ?? []).length > 0 && options.skipPrincipalTeardown !== true) await secondaryOrigins(ctx, runs)
	await revokeCredentials(ctx)
	await teardownAccounts(ctx)
	await revokeSessions(ctx)
}

async function secondaryOrigins(ctx: RunContext, runs: OriginRuns): Promise<void> {
	try {
		await runSecondaryOrigins(ctx, runs)
	} catch (error) {
		ctx.findings.blocked("run.error" satisfies RunFindingId, "origins", {
			summary: "the secondary origins stopped on an unexpected error",
			cause: errorText(error),
		})
	}
}
