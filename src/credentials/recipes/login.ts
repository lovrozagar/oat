import type { LoginRecipe, Recipe } from "../../config/types/security.ts"
import type { AuthStep } from "../../config/types/steps.ts"
import { expiresAtOf } from "../expiry.ts"
import { fillPrincipal } from "../interpolate.ts"
import { jwtClaims } from "../jwt.ts"
import { readPath } from "../../client/read-path.ts"
import { readAnswer } from "../read.ts"
import type { StepAnswer } from "../ports.ts"
import type { AcquireCtx, Issued } from "./types.ts"

/*
 * Sign in by running the recipe's steps through the run's step runner, once: a failed login is
 * reported, never retried. The credential is at `from` in the last answer, or a scope key a step
 * saved. `claims` binds JWT claims into the principal's identity. A recipe `refresh` runs its steps
 * with the scope the last run bound plus `credential`, so a rotated refresh token carries forward.
 */

interface Ran {
	scope: Record<string, string>
	answer: StepAnswer
}

/** Signs the principal in by the login recipe; `options` are the recipe's shared options. */
export async function acquireLogin(ctx: AcquireCtx, login: LoginRecipe, options: Partial<Recipe>): Promise<Issued> {
	return issue(ctx, { login, options, ran: await run(ctx, login.steps, {}) }, login.from)
}

interface Issuing {
	login: LoginRecipe
	options: Partial<Recipe>
	ran: Ran
}

function run(ctx: AcquireCtx, steps: readonly AuthStep[], scope: Record<string, string>): Promise<Ran> {
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
	const refresh = options.refresh
	if (refresh !== undefined) {
		issued.refresh = async () => {
			const renewed = await run(ctx, refresh.steps, { ...ran.scope, credential: value })
			return issue(ctx, { ...issuing, ran: renewed }, refresh.from)
		}
	}
	return issued
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
