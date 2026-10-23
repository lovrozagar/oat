/*
 * The accounts a check's own sign-up made, as an operation check reaches them: held as teardown holds
 * them (`accounts.ts`), so the principal a check reads as is the one teardown later removes the
 * account as, and never with a credential that is not the account's own.
 */

import type { CheckAccounts } from "../checks/core/operation-context.ts"
import { borrowedFor, configuredNotMade, holder, labelOf, signIn } from "./accounts.ts"
import type { RunContext } from "./context.ts"

/** What the security stage hands its checks: see `CheckAccounts`. */
export function checkAccounts(ctx: RunContext): CheckAccounts {
	return {
		signIn: async (signUp, read) => {
			const { accounts } = ctx
			const entry = accounts.entries().find((one) => accounts.signUpOf(one)?.answer?.seq === signUp.seq)
			if (entry === undefined) {
				return { untested: `the run's ledger holds no account ${signUp.operationId} #${signUp.seq} made` }
			}
			const held = holder(ctx, entry)
			if (held !== undefined && configuredNotMade(ctx, held)) {
				return { untested: `its name is configured principal ${held}'s, which this run did not make` }
			}
			const principal = held ?? (await signIn(ctx, entry))
			if (principal === undefined) return { untested: `the run holds no credential for the account ${labelOf(entry)}` }
			const why = await borrowedFor(ctx, principal, read)
			return why === undefined ? { principal } : { untested: `${read.operationId} is not sent as the account: ${why}` }
		},
	}
}
