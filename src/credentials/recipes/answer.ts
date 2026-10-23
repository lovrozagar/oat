import { describeAnswerType } from "../../runtime/cookies/save-as.ts"
import type { StepAnswer } from "../ports.ts"
import { readAnswer } from "../read.ts"
import type { AcquireCtx } from "./types.ts"

/* What every recipe asks of an answer and of the scopes it is acquiring for. */

/** A call answered with a status other than 2xx, which it keeps. */
export class RefusedAnswer extends Error {
	constructor(
		what: string,
		readonly status: number,
	) {
		super(`${what} answered ${status}`)
	}
}

/** Refuses an answer that is not 2xx: `what` says which call it was. */
export function answered(answer: StepAnswer, what: string): void {
	if (answer.status < 200 || answer.status >= 300) throw new RefusedAnswer(what, answer.status)
}

/** The credential at `from` in an answer, or a reason naming where it was looked for and the answer's type. */
export function valueAt(answer: StepAnswer, from: string, what: string): string {
	const value = readAnswer(answer, from)
	if (value === undefined)
		throw new Error(`${what} answered no credential at ${from} (${describeAnswerType(answer.headers)})`)
	return value
}

/** Refuses scopes a static or hooked credential does not say it holds. */
export function assertHolds(ctx: AcquireCtx, holds: readonly string[] | undefined): void {
	const held = new Set(holds)
	const missing = ctx.scopes.filter((scope) => !held.has(scope))
	if (missing.length > 0) {
		throw new Error(`the "${ctx.scheme.name}" credential does not hold ${missing.join(", ")}`)
	}
}
