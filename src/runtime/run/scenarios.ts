import { accountOps } from "../accounts/ops.ts"
import { deletedDuringRun } from "../accounts/watch.ts"
import { externalExcluded } from "../profile.ts"
import type { ScenarioAccounts } from "../scenario/lineage.ts"
import { runScenarios } from "../scenario/run.ts"
import type { RunContext } from "./context.ts"
import { stopped } from "./interrupt.ts"

/** The declared flows for operations the matrix cannot reach, after the matrix's fixtures are gone. */
export async function scenarios(ctx: RunContext): Promise<void> {
	const { progress, ownScenarios, state, client, principals, findings, grades, hooks, scope, model } = ctx
	progress.enter("scenario", `${ownScenarios.length} scenario(s)`)
	const accounts = scenarioAccounts(ctx)
	await runScenarios({
		...(accounts === undefined ? {} : { accounts }),
		checksRun: state.checksRun,
		client,
		defaultPrincipal: principals.alpha.id,
		findings,
		grades,
		hooks,
		inScope: (operationId) => scope.inScope(operationId),
		mode: scope.mode,
		model,
		originClients: ctx.originClients,
		outOfBand: ctx.options.outOfBand ?? {},
		principals: new Map(principals.all.map((principal) => [principal.id, { scope: principal.scope }])),
		blocked: new Map(principals.blocked.map((principal) => [principal.id, principal.reason])),
		scenarios: ownScenarios,
		skipped: (scenario) => externalExcluded(scenario, ctx.options.externals?.kinds, ctx.profile),
		stopped: () => stopped(ctx),
	})
}

/**
 * The run's ledger as a scenario reaches it, when the document can delete an account as itself: a
 * self delete settles an entry only while it is owed.
 */
function scenarioAccounts(ctx: RunContext): ScenarioAccounts | undefined {
	const { accounts } = ctx
	const deleteSelf = accountOps(ctx.model).deleteSelf?.operationId
	if (deleteSelf === undefined) return undefined
	return {
		deleteSelf,
		deletedItself: (entry, exchange) => {
			if (!accounts.owed().includes(entry)) return
			accounts.settle(entry, { note: deletedDuringRun(deleteSelf, exchange.seq), status: "removed" })
		},
		madeBy: (exchange) => accounts.madeBy(exchange),
	}
}
