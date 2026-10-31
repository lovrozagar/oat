import type { OperationCheck } from "../../core/check.ts"
/*
 * A credential without the scope an operation requires must be refused. For each alternative of one
 * scheme that names scopes, the actor's credential for that scheme issued with no scope at all is
 * sent in its place. Only a mint recipe issues a credential for the scopes asked: a login holds
 * whatever the server grants, and a grant asked for no scope gets the server's default, so either
 * would send a fully scoped credential and report a refusal that is not due. The key is acquired
 * through the store, once per run for the empty scope set, so teardown revokes it with the rest; it
 * is a real value, sent as a derived forged one and redacted. A refusal counts only once the same
 * actor's credential issued with the scopes is let in: a server that refuses the scheme outright, as
 * one whose API keys are broken does, refuses the bare credential too, and that is no scope check. The
 * control goes second, so a write it lets through never takes the record from the probe. Probes go
 * where `addressOf` puts them; mutating, since some write.
 */

import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import type { Requirement } from "../../../../spec/security/requirements.ts"
import { defineCheck } from "../../core/define.ts"
import { isUntested } from "../../core/operation.ts"
import type { OperationContext } from "../../core/operation-context.ts"
import { andThen, cannot, type Plan, ready } from "../../core/plan.ts"
import {
	type Address,
	addressOf,
	judgeRefusals,
	type Refusal,
	refused,
	securedPlan,
	send,
	singleSchemes,
} from "./probing.ts"

const ID = "auth.scope-enforced"

interface Planned {
	address: Address
	scoped: Requirement[]
}

export const scopeEnforced: OperationCheck<Planned> = defineCheck<Planned>({
	id: ID,
	mutates: true,
	needs: "an operation that requires a scope, of a scheme a mint recipe issues",
	plan: (ctx) =>
		andThen(securedPlan(ctx), () =>
			andThen(mintedPlan(ctx), (scoped) => andThen(addressOf(ctx), (address) => ready({ address, scoped }))),
		),
	async run(ctx, { address, scoped }) {
		const probes: Refusal[] = []
		const untested: string[] = []
		for (const requirement of scoped) {
			const probe = await probeWithout(ctx, address, requirement)
			if (typeof probe === "string") untested.push(probe)
			else probes.push(probe)
		}
		if (probes.length === 0) return standDown(untested.join("; "))
		const judged = judgeRefusals(ctx, ID, probes)
		return judged.kind === "asserted" ? controlled(ctx, address, scoped) : judged
	},
	subject: "operation",
})

/* The actor's credential for `requirement`'s scheme issued without its scopes, sent; or why it cannot be had. */
async function probeWithout(
	ctx: OperationContext,
	address: Address,
	{ scheme, scopes }: Requirement,
): Promise<Refusal | string> {
	const bare = await ctx.probe.held({ principal: ctx.actor.id, scheme, scopes: [] })
	if (isUntested(bare)) return bare.untested
	return {
		exchange: await send(ctx, address, { forged: { derived: true, scheme, value: bare.value } }),
		sent: `${ctx.actor.id}'s ${scheme} credential issued without ${scopes.join(" ")}`,
		summary: "an operation accepted a credential without the scope it requires",
	}
}

/*
 * Every bare credential was refused: asserted once the actor's credential issued with the scopes is
 * let in, for each scheme, and unresolved where it is refused too.
 */
async function controlled(ctx: OperationContext, address: Address, scoped: readonly Requirement[]): Promise<Outcome> {
	for (const { scheme, scopes } of scoped) {
		const full = await ctx.probe.held({ principal: ctx.actor.id, scheme, scopes })
		if (isUntested(full)) return standDown(full.untested)
		const control = await send(ctx, address, { forged: { derived: true, scheme, value: full.value } })
		if (refused(control.status)) {
			return ctx.findings.unresolved(
				ID,
				ctx.subject,
				`${ctx.subject} refused ${ctx.actor.id}'s ${scheme} credential issued with ${scopes.join(" ")} too ` +
					`(${control.status}), so the refusal without the scope proves nothing`,
			)
		}
	}
	return ASSERTED
}

/* The scoped alternatives of one scheme whose recipe is a mint, or why there are none. */
function mintedPlan(ctx: OperationContext): Plan<Requirement[]> {
	const scoped = singleSchemes(ctx.security).filter((requirement) => requirement.scopes.length > 0)
	if (scoped.length === 0) return cannot("an alternative that requires a scope")
	const minted: Requirement[] = []
	const reasons: string[] = []
	for (const requirement of scoped) {
		const recipe = ctx.probe.recipe({ principal: ctx.actor.id, scheme: requirement.scheme })
		if (isUntested(recipe)) reasons.push(recipe.untested)
		else if (recipe.kind === "mint") minted.push(requirement)
		else {
			reasons.push(
				`a mint recipe, which issues a credential for the scopes asked; ${ctx.actor.id}'s ${requirement.scheme} recipe is a ${recipe.kind} recipe`,
			)
		}
	}
	return minted.length === 0 ? cannot(reasons.join("; ")) : ready(minted)
}
