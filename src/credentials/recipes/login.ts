import type { LoginRecipe, Recipe } from "../../config/types/security.ts"
import type { AuthStep } from "../../config/types/steps.ts"
import { expiresAtOf } from "../expiry.ts"
import { fillCredential, fillPrincipal } from "../interpolate.ts"
import { jwtClaims } from "../jwt.ts"
import { unfilledIn } from "../placeholders.ts"
import { readPath } from "../../client/read-path.ts"
import { answerBody, describeAnswerType } from "../../runtime/cookies/save-as.ts"
import { readAnswer } from "../read.ts"
import type { Hop, StepAnswer } from "../ports.ts"
import { answered } from "./answer.ts"
import type { AcquireCtx, Issued } from "./types.ts"

/*
 * Sign in by running the recipe's steps through the run's step runner, once: a failed login is
 * reported, never retried. The credential is at `from` in the last answer, or a scope key a step
 * saved. `claims` binds JWT claims into the principal's identity. A recipe `refresh` runs its steps
 * with the scope the last run bound plus `credential`, so a rotated refresh token carries forward. A
 * declared `revoke` ends the session by sending exactly its value to that operation. Steps that
 * read a `{name}` nothing fills are refused before anything is sent, naming it.
 */

type LoginRevoke = NonNullable<LoginRecipe["revoke"]>

interface Ran {
	scope: Record<string, string>
	answer: StepAnswer
}

/** Signs the principal in by the login recipe; `options` are the recipe's shared options. */
export async function acquireLogin(ctx: AcquireCtx, login: LoginRecipe, options: Partial<Recipe>): Promise<Issued> {
	return issue(
		ctx,
		{
			login,
			options,
			ran: await run(ctx, login.steps, { scope: {}, secrets: secretsOf(login, options), what: "login" }),
		},
		login.from,
	)
}

interface Issuing {
	login: LoginRecipe
	options: Partial<Recipe>
	ran: Ran
}

async function run(
	ctx: AcquireCtx,
	steps: readonly AuthStep[],
	at: { scope: Record<string, string>; secrets: string[]; what: "login" | "refresh" } & Hop,
): Promise<Ran> {
	const unfilled = unfilledIn(steps, Object.keys(at.scope))
	if (unfilled !== undefined) {
		throw new Error(
			`${at.what} for "${ctx.principal.id}" reads {${unfilled.name}} at step ${unfilled.step}, ` +
				"which nothing it started from or an earlier step saved fills",
		)
	}
	const input = {
		principal: ctx.principal.id,
		scope: at.scope,
		secrets: at.secrets,
		...(at.probe ? { probe: at.probe } : {}),
	}
	return ctx.ports.steps.run(fillPrincipal(ctx.principal, steps), input)
}

/* Every address a login or its refresh reads a value from: each is a credential, or what renews one. */
function secretsOf(login: LoginRecipe, options: Partial<Recipe>): string[] {
	const steps = [...login.steps, ...(options.refresh?.steps ?? [])]
	const saved = steps.flatMap((step) =>
		"saveAs" in step && step.saveAs !== undefined ? Object.values(step.saveAs) : [],
	)
	return [...new Set([login.from, ...(options.refresh === undefined ? [] : [options.refresh.from]), ...saved])]
}

function issue(ctx: AcquireCtx, issuing: Issuing, from: string): Issued {
	const { login, options, ran } = issuing
	const value = readAnswer(ran.answer, from) ?? ran.scope[from]
	if (value === undefined || value === "") {
		const type = describeAnswerType(ran.answer.headers)
		throw new Error(`login for "${ctx.principal.id}" answered no credential at ${from} (${type})`)
	}
	const expiresAt = expiresAtOf({ body: answerBody(ran.answer), expiresIn: options.expiresIn, now: ctx.now(), value })
	const issued: Issued = { expiresAt, value }
	if (login.claims !== undefined) issued.identity = claimsOf(ctx, login.claims, value)
	const { revoke } = login
	if (revoke !== undefined) issued.revoke = () => revokeSession(ctx, { ran, revoke, value })
	return renewable(ctx, issuing, issued)
}

/*
 * Ends one session: its revoke operation, sent with exactly that session's value, which fills the
 * body too. A 401 counts as revoked; any other refusal is a session the run could not end.
 */
async function revokeSession(
	ctx: AcquireCtx,
	session: { ran: Ran; revoke: LoginRevoke; value: string },
): Promise<void> {
	const { ran, value } = session
	const { body, operationId } = typeof session.revoke === "string" ? { operationId: session.revoke } : session.revoke
	const as = { principal: ctx.principal.id, scheme: ctx.scheme.name }
	const call = { as, operationId, scope: { ...ran.scope, credential: value }, value }
	const sent = body === undefined ? call : { ...call, body: fillCredential(body, value) }
	const answer = await ctx.ports.operations.call(sent)
	/* It carried the very session it ends: a 401 says that session is unusable already, which is the revoke's aim. */
	if (answer.status !== 401) answered(answer, `revoke ${operationId}`)
}

/* The recipe's declared refresh, run with the scope the credential came with plus the credential itself. */
function renewable(ctx: AcquireCtx, issuing: Issuing, issued: Issued): Issued {
	const refresh = issuing.options.refresh
	if (refresh === undefined) return issued
	issued.refresh = async (hop = {}) => {
		const scope = { ...issuing.ran.scope, credential: issued.value }
		const secrets = secretsOf(issuing.login, issuing.options)
		const renewed = await run(ctx, refresh.steps, { scope, secrets, what: "refresh", ...hop })
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
