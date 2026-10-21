/*
 * A secured operation must refuse a request that carries no credential. Planned only where the
 * security requires one: an operation that lets anonymous callers in owes no refusal, and a document
 * that declares no security says nothing either way. Probes go where `addressOf` puts them, by their
 * placement; a write only to the run-created record, with its current state, so a broken API that
 * applies it changes nothing. Mutating, since some of its probes write.
 */

import { defineCheck } from "../../core/define.ts"
import { andThen } from "../../core/plan.ts"
import { type Address, addressOf, judgeRefusals, securedPlan, send } from "./probing.ts"

const ID = "auth.missing-credential-refused"

export const missingCredentialRefused = defineCheck<Address>({
	id: ID,
	mutates: true,
	needs: "an operation whose security requires a credential",
	plan: (ctx) => andThen(securedPlan(ctx), () => addressOf(ctx)),
	async run(ctx, address) {
		const exchange = await send(ctx, address, { anonymous: true })
		return judgeRefusals(ctx, ID, [
			{
				exchange,
				sent: "a request with no credential",
				summary: "a secured operation answered a request with no credential",
			},
		])
	},
	subject: "operation",
})
