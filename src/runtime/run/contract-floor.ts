import { runContractCalls } from "../contract/calls.ts"
import { confirmDeletes } from "../contract/deletes.ts"
import { proveFromTranscript } from "../evidence.ts"
import type { RunContext } from "./context.ts"
import { stopped } from "./interrupt.ts"

/**
 * The floor under every operation: what the transcript already proves, deletes confirmed, then a
 * documented call to each operation no check or scenario reached.
 */
export async function contractFloor(ctx: RunContext): Promise<void> {
	const { progress, client, grades, model, principals, findings, scope, state } = ctx
	const inScope = (operationId: string): boolean => scope.inScope(operationId)
	progress.enter("test", "evidence from the transcript")
	await proveFromTranscript({ client, grades, model })
	await confirmDeletes({
		auth: principals.alpha.headers,
		client,
		findings,
		grades,
		inScope,
		mode: scope.mode,
		model,
		stopped: () => stopped(ctx),
	})
	progress.enter("contract", "operations no check or scenario reached")
	await runContractCalls({
		auth: principals.alpha.headers,
		checksRun: state.checksRun,
		client,
		findings,
		grades,
		hooks: ctx.hooks,
		inScope,
		mode: scope.mode,
		model,
		nonce: ctx.nonce,
		owned: ctx.scenarioOwned,
		roots: principals.alpha.roots,
		seed: ctx.seed,
		stopped: () => stopped(ctx),
		validator: ctx.validator,
	})
}
