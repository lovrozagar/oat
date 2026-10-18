/**
 * Every destructive operation in scope, each run as a second user: one shared by the operations
 * that leave the session standing, and one of its own for each that ends it.
 */

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
	let shared: Session | null | undefined
	for (const [index, op] of ops.entries()) {
		const ends = invalidatesCaller(op, read)
		let session: Session | null
		try {
			session = ends ? await signUp(input, `${index}`) : (shared ??= await signUp(input, "shared"))
		} catch (error) {
			input.grades.skipped(
				[op.operationId],
				`the second user could not sign up: ${error instanceof Error ? error.message : String(error)}`,
			)
			continue
		}
		if (session === null) {
			input.grades.skipped([op.operationId], "no way to sign up a second user (an auth flow or x-fresh-principal)")
			continue
		}
		await runOne(input, { ends, op, read, session })
	}
}
