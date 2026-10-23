import { probeOwner } from "../../credentials/probe-principal.ts"
import { signInFields } from "../../credentials/sign-in-fields.ts"
import type { OwnRecords } from "../own-record.ts"
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
	return {
		disposable: () => {
			disposable ??= enrollerOf(ctx)("own-record").then((enrolled) => ("blocked" in enrolled ? enrolled : enrolled.id))
			return disposable
		},
		identityOf: (principal) => ctx.principals.byId.get(probeOwner(principal))?.identity,
		signIn: new Set(recipesOf(ctx).flatMap((recipe) => [...signInFields(recipe)])),
	}
}
