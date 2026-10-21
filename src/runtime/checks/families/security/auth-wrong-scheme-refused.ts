/*
 * A secured operation must refuse a valid credential of a scheme it does not list: a route the
 * document secures with jwt alone takes no API key, however real. For each declared scheme another
 * operation of the document names and this one does not, the actor's own credential for it (with the
 * scopes it is first named with) is sent in its place. It is a real value, so it is sent as a derived
 * forged one, redacted like the credential. Probes go where `addressOf` puts them; mutating, since
 * some write.
 */

import { standDown } from "../../../finding.ts"
import type { Requirement } from "../../../../spec/security/requirements.ts"
import { defineCheck } from "../../core/define.ts"
import { isUntested } from "../../core/operation.ts"
import { andThen, cannot, ready } from "../../core/plan.ts"
import { type Address, addressOf, documentSchemes, judgeRefusals, type Refusal, securedPlan, send } from "./probing.ts"

const ID = "auth.wrong-scheme-refused"

interface Planned {
	address: Address
	others: Requirement[]
}

export const wrongSchemeRefused = defineCheck<Planned>({
	id: ID,
	mutates: true,
	needs: "an operation whose security requires a credential, and a scheme it does not list",
	plan: (ctx) =>
		andThen(securedPlan(ctx), () => {
			const listed = new Set(ctx.security.alternatives.flat().map((requirement) => requirement.scheme))
			const others = documentSchemes(ctx.model).filter((requirement) => !listed.has(requirement.scheme))
			if (others.length === 0) return cannot(`a scheme the document uses that ${ctx.subject} does not list`)
			return andThen(addressOf(ctx), (address) => ready({ address, others }))
		}),
	async run(ctx, { address, others }) {
		const probes: Refusal[] = []
		const untested: string[] = []
		for (const { scheme, scopes } of others) {
			const held = await ctx.probe.held({ principal: ctx.actor.id, scheme, scopes })
			if (isUntested(held)) {
				untested.push(held.untested)
				continue
			}
			probes.push({
				exchange: await send(ctx, address, { forged: { derived: true, scheme, value: held.value } }),
				sent: `${ctx.actor.id}'s ${scheme} credential, a scheme it does not list`,
				summary: "an operation accepted a credential of a scheme it does not list",
			})
		}
		return probes.length === 0 ? standDown(untested.join("; ")) : judgeRefusals(ctx, ID, probes)
	},
	subject: "operation",
})
