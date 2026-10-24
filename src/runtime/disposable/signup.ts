/**
 * Signing up the second user: a principal of the run's own, enrolled in its store through the
 * document's `x-fresh-principal` operation, so its requests go `as` it and are placed by each
 * operation's security, refreshed and retried on a 401 like any configured principal's.
 */

import type { DisposableInput, Session } from "./types.ts"

/** The second user labeled `label`, as a session; BLOCKED with the reason when it cannot be signed up. */
export async function signUp(input: DisposableInput, label: string): Promise<Session | { blocked: string }> {
	const enrolled = await input.enroll(label)
	if ("blocked" in enrolled) return enrolled
	const { id, known, renew, scope } = enrolled
	return { known, principal: id, scope, ...(renew === undefined ? {} : { renew }) }
}
