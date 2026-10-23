import type { MintRecipe, Recipe } from "../../config/types/security.ts"
import { expiresAtOf } from "../expiry.ts"
import { fillPrincipal, principalValues } from "../interpolate.ts"
import { answerBody } from "../../runtime/cookies/save-as.ts"
import type { StepAnswer } from "../ports.ts"
import { answered, valueAt } from "./answer.ts"
import type { AcquireCtx, Issued } from "./types.ts"

/*
 * Make a credential by calling an operation as the principal with another scheme's credential: an
 * API key created with a session, say. `{scopes}` in the body is the scope set the operation needs, as an array where
 * it is the whole value and space-joined inside text. Each identity value the body sends is registered
 * as a secret before it is sent. The minted credential records how to revoke it.
 */

const SCOPES = "{scopes}"

/** Mints the credential by the mint recipe; `options` are the recipe's shared options. */
export async function acquireMint(ctx: AcquireCtx, mint: MintRecipe, options: Partial<Recipe>): Promise<Issued> {
	const body = mint.body === undefined ? {} : { body: withScopes(fillPrincipal(ctx.principal, mint.body), ctx.scopes) }
	const call = { as: asWith(ctx, mint), operationId: mint.operationId, secrets: [mint.from], ...body }
	for (const value of principalValues(ctx.principal, mint.body)) ctx.ports.secrets.register(value)
	const answer = await ctx.ports.operations.call(call)
	answered(answer, `mint ${mint.operationId}`)
	const value = valueAt(answer, mint.from, `mint ${mint.operationId}`)
	const issued: Issued = {
		expiresAt: expiresAtOf({ body: answerBody(answer), expiresIn: options.expiresIn, now: ctx.now(), value }),
		scopes: ctx.scopes,
		value,
	}
	const revoke = mint.revoke
	if (revoke !== undefined) issued.revoke = () => revokeMinted(ctx, { answer, mint, revoke, value })
	return issued
}

interface Minted {
	mint: MintRecipe
	revoke: string
	answer: StepAnswer
	value: string
}

/* The revoke operation's path parameters come from the minted value and the mint answer's own fields. */
async function revokeMinted(ctx: AcquireCtx, { answer, mint, revoke, value }: Minted): Promise<void> {
	const scope = { ...scalarFields(answer.body), credential: value }
	answered(await ctx.ports.operations.call({ as: asWith(ctx, mint), operationId: revoke, scope }), `revoke ${revoke}`)
}

/* The principal, sending the scheme the recipe mints with. */
function asWith(ctx: AcquireCtx, mint: MintRecipe): { principal: string; scheme: string } {
	return { principal: ctx.principal.id, scheme: mint.with }
}

function scalarFields(body: unknown): Record<string, string> {
	if (body === null || typeof body !== "object") return {}
	const scalars = Object.entries(body).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
	return Object.fromEntries(scalars.map(([key, value]) => [key, String(value)]))
}

function withScopes(value: unknown, scopes: readonly string[]): unknown {
	if (value === SCOPES) return [...scopes]
	if (typeof value === "string") return value.replaceAll(SCOPES, scopes.join(" "))
	if (Array.isArray(value)) return value.map((item) => withScopes(item, scopes))
	if (value === null || typeof value !== "object") return value
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withScopes(item, scopes)]))
}
