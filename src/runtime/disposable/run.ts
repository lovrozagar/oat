/**
 * Every destructive operation in scope, each run as a second user: one shared by the operations
 * that leave the session standing, and one of its own for each that ends it.
 */

import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { callerRead, destructiveOps, DISPOSABLE_CHECK_ID, invalidatesCaller } from "./check.ts"
import { runOne } from "./one.ts"
import { signUp } from "./signup.ts"
import type { DisposableInput, Session } from "./types.ts"

export async function runDisposableOps(input: DisposableInput): Promise<void> {
	const ops = destructiveOps(input.model).filter((op) => input.mode === "full" || input.inScope(op.operationId))
	if (ops.length === 0) return
	input.checksRun?.add(DISPOSABLE_CHECK_ID)
	const read = callerRead(input.model)
	if (read === undefined) {
		input.grades.skipped(
			ops.map((op) => op.operationId),
			"no caller read (an identity: self read)",
		)
		return
	}
	/* An operation that ends the session gets a user of its own, so no order between them matters. */
	let shared: Session | undefined
	for (const [index, op] of ops.entries()) {
		const ends = invalidatesCaller(op, read)
		let session: Session | { blocked: string }
		try {
			session = ends ? await signUp(input, `${index}`) : (shared ?? (await signUp(input, "shared")))
		} catch (error) {
			session = { blocked: error instanceof Error ? error.message : String(error) }
		}
		if ("blocked" in session) {
			input.grades.skipped([op.operationId], `the second user could not sign up: ${session.blocked}`)
			continue
		}
		if (!ends) shared = session
		await runAsSecondUser(input, { ends, op, read, session })
	}
}

/* One operation as the second user; a credential it cannot hold (a renewal that would sign up again) skips it, with why. */
async function runAsSecondUser(input: DisposableInput, run: Parameters<typeof runOne>[1]): Promise<void> {
	try {
		await runOne(input, run)
	} catch (error) {
		if (!(error instanceof UnsatisfiedSecurity)) throw error
		input.grades.skipped([run.op.operationId], error.message)
	}
}
