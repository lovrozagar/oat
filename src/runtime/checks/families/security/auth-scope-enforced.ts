/*
 * A credential without the scope an operation requires must be refused. For each alternative of one
 * scheme that names scopes, the actor's credential for that scheme issued with no scope at all is
 * sent in its place. Only a mint recipe issues a credential for the scopes asked: a login holds
 * whatever the server grants, and a grant asked for no scope gets the server's default, so either
 * would send a fully scoped credential and report a refusal that is not due. The key is acquired
 * through the store, once per run for the empty scope set, so teardown revokes it with the rest; it
 * is a real value, sent as a derived forged one and redacted. Probes go where `addressOf` puts them;
 * mutating, since some write.
 */

import { standDown } from "../../../finding.ts"
import type { Requirement } from "../../../../spec/security/requirements.ts"
import { defineCheck } from "../../core/define.ts"
import { isUntested } from "../../core/operation.ts"
import type { OperationContext } from "../../core/operation-context.ts"
import { andThen, cannot, type Plan, ready } from "../../core/plan.ts"
import { type Address, addressOf, judgeRefusals, type Refusal, securedPlan, send, singleSchemes } from "./probing.ts"

const ID = "auth.scope-enforced"

interface Planned {
	address: Address
	scoped: Requirement[]
}

export const scopeEnforced = defineCheck<Planned>({
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
		for (const { scheme, scopes } of scoped) {
			const bare = await ctx.probe.held({ principal: ctx.actor.id, scheme, scopes: [] })
			if (isUntested(bare)) {
				untested.push(bare.untested)
				continue
			}
			probes.push({
				exchange: await send(ctx, address, { forged: { derived: true, scheme, value: bare.value } }),
				sent: `${ctx.actor.id}'s ${scheme} credential issued without ${scopes.join(" ")}`,
				summary: "an operation accepted a credential without the scope it requires",
			})
		}
		return probes.length === 0 ? standDown(untested.join("; ")) : judgeRefusals(ctx, ID, probes)
	},
	subject: "operation",
})

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
