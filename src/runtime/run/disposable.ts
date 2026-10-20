import type { Recipe } from "../../config/types/security.ts"
import { effectiveRecipe } from "../../credentials/effective.ts"
import { runDisposableOps } from "../disposable/run.ts"
import type { DisposableInput, Enrolled } from "../disposable/types.ts"
import type { Exchange } from "../exchange.ts"
import type { RunContext } from "./context.ts"
import { provision } from "./fresh.ts"
import { boundOf } from "./identity.ts"
import { logIn } from "./principals.ts"

/**
 * Operations that consume their subject — delete-account, revoke-self — each on a principal of its
 * own: signed up by the document's `x-fresh-principal` operation and bound in the run's store, so
 * it refreshes and retries a 401 like any configured principal (D7).
 */
export async function disposable(ctx: RunContext): Promise<void> {
	const { principals, state, client, findings, grades, scope, model, nonce, hooks, seed } = ctx
	await runDisposableOps({
		checksRun: state.checksRun,
		client,
		enroll: enrollerOf(ctx),
		findings,
		grades,
		inScope: (operationId) => scope.inScope(operationId),
		mode: scope.mode,
		model,
		nonce,
		principal: principals.alpha.id,
		...(hooks.resolveInput === undefined ? {} : { resolveInput: hooks.resolveInput }),
		seed,
	})
}

/**
 * Signs a session up as `disposable-<label>` on the shared recipes, and in as the principals stage
 * does, so its login's claims bind its scope. Its `renew` runs the recipe's declared refresh.
 */
export function enrollerOf(ctx: RunContext): DisposableInput["enroll"] {
	return async (label) => {
		const id = `disposable-${label}`
		const made = await provision(ctx, { entry: {}, id, label })
		if ("blocked" in made) return made
		const reason = await logIn(ctx, id, {})
		if (reason !== undefined) return { blocked: reason }
		const enrolled: Enrolled = { ...made, scope: boundOf(ctx.store.identityOf(id)).scope }
		const scheme = refreshedScheme(ctx.options.security ?? {})
		return scheme === undefined ? enrolled : { ...enrolled, renew: () => renew(ctx, { id, scheme }) }
	}
}

/* The first scheme whose recipe declares a refresh: the one a session's renewal runs. */
function refreshedScheme(security: Readonly<Record<string, Partial<Recipe>>>): string | undefined {
	return Object.keys(security).find((scheme) => effectiveRecipe(security[scheme], undefined)?.refresh !== undefined)
}

/*
 * The session's declared refresh, run once for the credential it holds, never a fresh sign-in; the
 * exchange it ended on, which a refused refresh still leaves. A refusal BLOCKS that session's
 * credential, which is what an ended session should be.
 */
async function renew(ctx: RunContext, held: { id: string; scheme: string }): Promise<Exchange | undefined> {
	const { client, store } = ctx
	const before = client.transcript.length
	const current = (await store.snapshot()).find((entry) => entry.principal === held.id && entry.scheme === held.scheme)
	if (current === undefined) return undefined
	await store.refresh({ principal: held.id, scheme: held.scheme, sentValue: current.credential.value })
	return client.transcript.slice(before).at(-1)
}
