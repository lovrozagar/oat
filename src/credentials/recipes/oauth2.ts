import type { ExpiresIn, OAuth2Recipe, Recipe } from "../../config/types/security.ts"
import { expiresAtOf } from "../expiry.ts"
import { fillPrincipal, principalValues } from "../interpolate.ts"
import { answerBody } from "../../runtime/cookies/save-as.ts"
import type { Hop } from "../ports.ts"
import { readAnswer } from "../read.ts"
import { answered, valueAt } from "./answer.ts"
import type { AcquireCtx, Issued } from "./types.ts"

/*
 * An OAuth 2 grant oat performs itself (RFC 6749 §4.3, §4.4): a form POST to the token URL the
 * scheme declares for the flow. Each identity value the form sends (a password grant's username and
 * password, say) is registered as a secret before it is sent. The scope is the set the operation
 * needs, else the recipe's own.
 * The lifetime is the recipe's `expiresIn`, else the answer's `expires_in`, else the JWT's `exp`.
 * An answer with a `refresh_token` renews by that grant, keeping a rotated one; without one, the
 * store renews by running the grant again.
 */

const GRANT = { clientCredentials: "client_credentials", password: "password" } as const

/** Gets an access token by the recipe's grant; `options` are the recipe's shared options. */
export async function acquireOAuth2(ctx: AcquireCtx, oauth2: OAuth2Recipe, options: Partial<Recipe>): Promise<Issued> {
	const scheme = ctx.scheme
	const tokenUrl = scheme.kind === "oauth2" ? scheme.flows[oauth2.flow]?.tokenUrl : undefined
	if (tokenUrl === undefined) {
		throw new Error(`the "${scheme.name}" scheme declares no tokenUrl for the ${oauth2.flow} flow`)
	}
	const filled = fillPrincipal(ctx.principal, oauth2)
	for (const value of principalValues(ctx.principal, oauth2)) ctx.ports.secrets.register(value)
	const scopes = ctx.scopes.length > 0 ? ctx.scopes : (filled.scopes ?? [])
	const client: Record<string, string> = { client_id: filled.clientId }
	if (filled.clientSecret !== undefined) client.client_secret = filled.clientSecret
	if (scopes.length > 0) client.scope = scopes.join(" ")
	const form: Record<string, string> = { ...client, grant_type: GRANT[filled.flow] }
	if (filled.username !== undefined) form.username = filled.username
	if (filled.password !== undefined) form.password = filled.password
	const expiresIn = options.expiresIn ?? { from: "$.expires_in" }
	return token(ctx, { client, expiresIn, scopes, tokenUrl }, form)
}

interface Grant {
	tokenUrl: string
	/** The client and scope every request to the token URL repeats. */
	client: Record<string, string>
	scopes: readonly string[]
	expiresIn: ExpiresIn
	/** The latest refresh token the token URL issued. */
	refreshToken?: string
}

/* One token request. A refresh token, new or carried forward, renews by the refresh_token grant (§6). */
async function token(ctx: AcquireCtx, grant: Grant, form: Record<string, string>, hop?: Hop): Promise<Issued> {
	const answer = await ctx.ports.tokens.post(grant.tokenUrl, form, hop)
	answered(answer, "oauth2 token request")
	const value = valueAt(answer, "$.access_token", "oauth2 token request")
	const expiresAt = expiresAtOf({ body: answerBody(answer), expiresIn: grant.expiresIn, now: ctx.now(), value })
	const issued: Issued = { expiresAt, scopes: grant.scopes, value }
	const refreshToken = readAnswer(answer, "$.refresh_token") ?? grant.refreshToken
	if (refreshToken !== undefined) {
		const renewal = { ...grant.client, grant_type: "refresh_token", refresh_token: refreshToken }
		issued.refresh = (again) => token(ctx, { ...grant, refreshToken }, renewal, again)
	}
	return issued
}
