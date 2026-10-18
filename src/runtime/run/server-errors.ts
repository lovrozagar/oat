import { reportServerErrors } from "../server-errors.ts"
import type { RunContext } from "./context.ts"

/** Every 5xx the run met, judged last so a teardown delete that crashed is counted too. */
export function serverErrors({
	state,
	findings,
	grades,
	scope,
	model,
	network,
	client,
	originClients,
}: RunContext): void {
	reportServerErrors({
		checksRun: state.checksRun,
		findings,
		grades,
		inScope: (operationId) => scope.inScope(operationId),
		mode: scope.mode,
		model,
		networkDown: network.outcome?.incomplete === true,
		transcripts: [client.transcript, ...[...originClients.values()].map((origin) => origin.client.transcript)],
	})
}
