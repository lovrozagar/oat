import { runDisposableOps, signupOperationId } from "../disposable.ts"
import type { RunContext } from "./context.ts"

/** Operations that consume their subject — delete-account, revoke-self — each on a principal of its own. */
export async function disposable(ctx: RunContext): Promise<void> {
	const { options, principals, state, client, findings, grades, scope, model, nonce, hooks, outOfBand, seed } = ctx
	const first = options.principals[0]
	const registerOperationId = signupOperationId(first?.auth)
	await runDisposableOps({
		auth: principals.alpha.headers,
		checksRun: state.checksRun,
		client,
		findings,
		grades,
		inScope: (operationId) => scope.inScope(operationId),
		mode: scope.mode,
		model,
		nonce,
		...(first?.auth === undefined ? {} : { authFlow: first.auth }),
		hooks,
		outOfBand,
		...(registerOperationId === undefined ? {} : { registerOperationId }),
		...(hooks.resolveInput === undefined ? {} : { resolveInput: hooks.resolveInput }),
		...(first?.rootsFromFlow === undefined ? {} : { rootsFromFlow: first.rootsFromFlow }),
		seed,
	})
}
