/*
 * A secured operation must refuse a credential no one issued. For each alternative of one scheme it
 * sends garbage placed like that scheme's credential; where the actor's own credential for the
 * scheme is a JWT, it also sends that JWT with its signature altered, which only a server that skips
 * verification accepts. The altered JWT is derived from a real one, so it is redacted like it.
 * Probes go where `addressOf` puts them, by placement. Mutating, since some of its probes write.
 */

import type { Requirement } from "../../../../spec/security/requirements.ts"
import { defineCheck } from "../../core/define.ts"
import { isUntested } from "../../core/operation.ts"
import type { OperationContext } from "../../core/operation-context.ts"
import { andThen, cannot, ready } from "../../core/plan.ts"
import { type Address, addressOf, judgeRefusals, type Refusal, securedPlan, send, singleSchemes } from "./probing.ts"

const ID = "auth.invalid-credential-refused"

/** A value no scheme issues: garbage, so it stays visible in the journal. */
export const GARBAGE = "oat-invalid-credential"

/** Whether `value` is a JWT: three base64url segments, the first a JSON header naming its `alg`. */
export function isJwt(value: string): boolean {
	const [header, payload, signature, ...rest] = value.split(".")
	if (rest.length > 0 || !header || !payload || !signature) return false
	try {
		const decoded: unknown = JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
		return typeof decoded === "object" && decoded !== null && typeof (decoded as { alg?: unknown }).alg === "string"
	} catch {
		return false
	}
}

/** The JWT with its signature's first character changed: every bit of it counts, unlike the last's. */
export function flipSignature(jwt: string): string {
	const at = jwt.lastIndexOf(".") + 1
	return `${jwt.slice(0, at)}${jwt[at] === "A" ? "B" : "A"}${jwt.slice(at + 1)}`
}

interface Planned {
	address: Address
	schemes: Requirement[]
}

export const invalidCredentialRefused = defineCheck<Planned>({
	id: ID,
	mutates: true,
	needs: "an operation whose security requires a credential",
	plan: (ctx) =>
		andThen(securedPlan(ctx), () => {
			const schemes = singleSchemes(ctx.security)
			if (schemes.length === 0) return cannot("an alternative of one scheme, for a credential to stand in for")
			return andThen(addressOf(ctx), (address) => ready({ address, schemes }))
		}),
	async run(ctx, { address, schemes }) {
		const probes: Refusal[] = []
		for (const requirement of schemes) probes.push(...(await probesOf(ctx, { address, requirement })))
		return judgeRefusals(ctx, ID, probes)
	},
	subject: "operation",
})

/* Garbage for the scheme, then the actor's own JWT for it with its signature altered, where it holds one. */
async function probesOf(ctx: OperationContext, at: { address: Address; requirement: Requirement }): Promise<Refusal[]> {
	const { address, requirement } = at
	const { scheme } = requirement
	const garbage = await send(ctx, address, { forged: { scheme, value: GARBAGE } })
	const probes: Refusal[] = [
		{
			exchange: garbage,
			sent: `an invalid ${scheme} credential`,
			summary: "a secured operation accepted an invalid credential",
		},
	]
	const held = await ctx.probe.held({ principal: ctx.actor.id, scheme, scopes: requirement.scopes })
	if (isUntested(held) || !isJwt(held.value)) return probes
	const altered = await send(ctx, address, { forged: { derived: true, scheme, value: flipSignature(held.value) } })
	probes.push({
		exchange: altered,
		sent: `${ctx.actor.id}'s ${scheme} JWT with its signature altered`,
		summary: "a secured operation accepted a JWT whose signature was altered",
	})
	return probes
}
