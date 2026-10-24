import { probeOwner } from "../../credentials/probe-principal.ts"
import { mintedRecords } from "../credential-records.ts"
import { signInFields } from "../../credentials/sign-in-fields.ts"
import { type OwnRecords, ownRecordsFrom } from "../own-record.ts"
import type { RunContext } from "./context.ts"
import { enrollerOf } from "./disposable.ts"
import { recipesOf } from "./floor-credentials.ts"

/*
 * The run's guard over its principals' own records: what every principal's recipe signs in with,
 * whose records are guarded (every configured principal; a session the run signed up to throw
 * away is not), and that one disposable session, signed up on the first write that needs it.
 */

/** The run's one `OwnRecords`, made on first use and kept in its state. */
export function ownRecordsOf(ctx: RunContext): OwnRecords {
	ctx.state.ownRecords ??= build(ctx)
	return ctx.state.ownRecords
}

function build(ctx: RunContext): OwnRecords {
	let disposable: Promise<string | { blocked: string }> | undefined
	/*
	 * A configured principal's identity as its config states it. What its sign-in binds (its tenant,
	 * a project in its scope) names records it belongs to, not its own; its own id comes from its self
	 * read, which `ownRecordsFrom` learns.
	 */
	const identityOf = (principal: string): Readonly<Record<string, unknown>> | undefined =>
		ctx.principals.byId.get(probeOwner(principal))?.identity
	/* Each mint recipe's operation: what it answered the credential store is a record the run holds. */
	const mintOps = new Set(
		recipesOf(ctx).flatMap((recipe) => (recipe.mint === undefined ? [] : [recipe.mint.operationId])),
	)
	return ownRecordsFrom({
		credentials: () =>
			mintedRecords({
				exchanges: [...mintOps].flatMap((operationId) => ctx.client.exchangesFor(operationId)),
				mintOps,
				model: ctx.model,
			}),
		disposable: () => {
			disposable ??= enrollerOf(ctx)("own-record").then((enrolled) => ("blocked" in enrolled ? enrolled : enrolled.id))
			return disposable
		},
		identityOf,
		signIn: new Set(recipesOf(ctx).flatMap((recipe) => [...signInFields(recipe)])),
	})
}
