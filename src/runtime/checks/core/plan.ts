import type { UnsatisfiedSecurity } from "../../../client/credential-source.ts"

/**
 * What a check's planning step decided: it can run, with what it needs to — or it cannot, and why.
 *
 * Planning is the only place a check decides whether it applies, and `run` receives what the plan
 * found instead of looking again. A check that applies but then finds nothing to test cannot
 * happen by construction: the two questions are one.
 */
export type Plan<T> = { ok: true; value: T } | { ok: false; needs?: string; blockedBy?: UnsatisfiedSecurity }

export function ready<T>(value: T): Plan<T> {
	return { ok: true, value }
}

/**
 * The check cannot run here; `needs` says what is missing, else the check's own `needs` does.
 * `blockedBy` is the BLOCKED credential when that is why: the check could not complete, which the
 * run reports as such, whatever words `needs` ends up in.
 */
export function cannot(
	needs?: string,
	{ blockedBy }: { blockedBy?: UnsatisfiedSecurity | undefined } = {},
): Plan<never> {
	return {
		ok: false,
		...(needs === undefined ? {} : { needs }),
		...(blockedBy === undefined ? {} : { blockedBy }),
	}
}

/** `next`, once `gate` holds — a plan built in stages, stopping at the first thing missing. */
export function andThen<A, T>(gate: Plan<A>, next: (value: A) => Plan<T>): Plan<T> {
	return gate.ok ? next(gate.value) : gate
}

/** A plan that carries nothing: the check applies exactly when `condition` holds. */
export function when(condition: boolean, needs?: string): Plan<undefined> {
	return condition ? { ok: true, value: undefined } : cannot(needs)
}
