import { runPublicGets } from "../one-shot.ts"
import type { RunContext } from "./context.ts"

/** Each GET that needs no auth and no fixture, read once before the entities. */
export async function publicGets({ state, client, findings, grades, scope, model }: RunContext): Promise<void> {
	await runPublicGets({
		checksRun: state.checksRun,
		client,
		findings,
		grades,
		inScope: (operationId) => scope.inScope(operationId),
		mode: scope.mode,
		model,
	})
}
