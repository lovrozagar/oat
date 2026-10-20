import type { LoginRecipe, Recipe } from "../../config/types/security.ts"
import type { AuthStep } from "../../config/types/steps.ts"
import { expiresAtOf } from "../expiry.ts"
import { fillPrincipal } from "../interpolate.ts"
import { jwtClaims } from "../jwt.ts"
import { unfilledIn } from "../placeholders.ts"
import { readPath } from "../../client/read-path.ts"
import { readAnswer } from "../read.ts"
import type { StepAnswer } from "../ports.ts"
import type { AcquireCtx, Issued } from "./types.ts"

/*
 * Sign in by running the recipe's steps through the run's step runner, once: a failed login is
 * reported, never retried. The credential is at `from` in the last answer, or a scope key a step
 * saved. `claims` binds JWT claims into the principal's identity. A recipe `refresh` runs its steps
 * with the scope the last run bound plus `credential`, so a rotated refresh token carries forward.
 * Steps that read a `{name}` nothing fills are refused before anything is sent, naming it.
 */

interface Ran {
	scope: Record<string, string>
	answer: StepAnswer
}

/** Signs the principal in by the login recipe; `options` are the recipe's shared options. */
export async function acquireLogin(ctx: AcquireCtx, login: LoginRecipe, options: Partial<Recipe>): Promise<Issued> {
	return issue(ctx, { login, options, ran: await run(ctx, login.steps, { scope: {}, what: "login" }) }, login.from)
}

interface Issuing {
	login: LoginRecipe
	options: Partial<Recipe>
	ran: Ran
}

async function run(
	ctx: AcquireCtx,
	steps: readonly AuthStep[],
	at: { scope: Record<string, string>; what: "login" | "refresh" },
): Promise<Ran> {
	const { scope, what } = at
	const unfilled = unfilledIn(steps, Object.keys(scope))
	if (unfilled !== undefined) {
		throw new Error(
			`${what} for "${ctx.principal.id}" reads {${unfilled.name}} at step ${unfilled.step}, ` +
				"which nothing it started from or an earlier step saved fills",
		)
	}
	return ctx.ports.steps.run(fillPrincipal(ctx.principal, steps), { principal: ctx.principal.id, scope })
}

function issue(ctx: AcquireCtx, issuing: Issuing, from: string): Issued {
	const { login, options, ran } = issuing
	const value = readAnswer(ran.answer, from) ?? ran.scope[from]
	if (value === undefined || value === "") {
		throw new Error(`login for "${ctx.principal.id}" answered no credential at ${from}`)
	}
	const expiresAt = expiresAtOf({ body: ran.answer.body, expiresIn: options.expiresIn, now: ctx.now(), value })
	const issued: Issued = { expiresAt, value }
	if (login.claims !== undefined) issued.identity = claimsOf(ctx, login.claims, value)
	return renewable(ctx, issuing, issued)
}

/* The recipe's declared refresh, run with the scope the credential came with plus the credential itself. */
function renewable(ctx: AcquireCtx, issuing: Issuing, issued: Issued): Issued {
	const refresh = issuing.options.refresh
	if (refresh === undefined) return issued
	issued.refresh = async () => {
		const scope = { ...issuing.ran.scope, credential: issued.value }
		const renewed = await run(ctx, refresh.steps, { scope, what: "refresh" })
		return issue(ctx, { ...issuing, ran: renewed }, refresh.from)
	}
	return issued
}

/**
 * A login credential the run was handed rather than signed in for, a signup's answer or an
 * invite's: it renews by the recipe's declared refresh from `held.scope` (a `refresh_token`, say),
 * as a signed-in one does from what its steps saved. With no refresh declared, the store signs in again.
 */
export function heldLogin(
	ctx: AcquireCtx,
	held: { value: string; scope: Readonly<Record<string, string>> },
	options: Partial<Recipe>,
): Issued {
	const { value } = held
	const expiresAt = expiresAtOf({ body: undefined, expiresIn: options.expiresIn, now: ctx.now(), value })
	const ran = { answer: { body: undefined, cookies: {}, headers: {}, status: 200 }, scope: { ...held.scope } }
	return renewable(ctx, { login: options.login as LoginRecipe, options, ran }, { expiresAt, value })
}

function claimsOf(ctx: AcquireCtx, claims: Record<string, string>, value: string): Record<string, string> {
	const decoded = jwtClaims(value)
	const who = `login for "${ctx.principal.id}"`
	if (decoded === null) throw new Error(`${who} binds claims, but its credential is not a JWT`)
	const identity: Record<string, string> = {}
	for (const [name, path] of Object.entries(claims)) {
		const claim = readPath(decoded, path)
		if (claim === undefined || claim === null) {
			throw new Error(
				`${who} binds ${name} to claim "${path}", which the token does not carry ` +
					`(it has ${Object.keys(decoded).join(", ")})`,
			)
		}
		identity[name] = String(claim)
	}
	return identity
}
