import { runScenarios } from "../scenario/run.ts"
import type { RunContext } from "./context.ts"
import { stopped } from "./interrupt.ts"

/** The declared flows for operations the matrix cannot reach, after the matrix's fixtures are gone. */
export async function scenarios(ctx: RunContext): Promise<void> {
	const { progress, ownScenarios, state, client, principals, findings, grades, hooks, scope, model } = ctx
	progress.enter("scenario", `${ownScenarios.length} scenario(s)`)
	await runScenarios({
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
		principals: new Map(
			principals.all.map((principal) => [principal.id, { headers: principal.headers, roots: principal.roots }]),
		),
		scenarios: ownScenarios,
		stopped: () => stopped(ctx),
	})
}
