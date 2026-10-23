import type { OperationCheck } from "../../core/check.ts"
/*
 * Each alternative an operation documents must work on its own. Every alternative of one scheme
 * besides the first is sent alone, with that scheme, as the principal that may expect it accepted:
 * the creator of the record a read of one record targets, else the actor (`acceptorOf`). A refusal is the backend breaking
 * its own contract only when the same request with the first alternative succeeds: otherwise (refused,
 * not found, a server error) the actor may simply lack access, and the refusal says nothing of the scheme. Reads alone: a write
 * accepted, as it should be, would apply. A collection read runs before the lanes; a read of one
 * record after them, on the run-created record.
 */

import type { Actor } from "../../../../client/credential-source.ts"
import { UnsatisfiedSecurity } from "../../../../client/credential-source.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import type { Requirement } from "../../../../spec/security/requirements.ts"
import { defineCheck } from "../../core/define.ts"
import { isReadMethod } from "../../core/operation.ts"
import type { OperationContext } from "../../core/operation-context.ts"
import { andThen, cannot, ready, when } from "../../core/plan.ts"
import {
	acceptorOf,
	type Address,
	addressOf,
	declaredPlan,
	describeSecurity,
	refused,
	send,
	singleSchemes,
} from "./probing.ts"

const ID = "auth.alternative-accepted"

interface Planned {
	address: Address
	alternatives: Requirement[]
}

export const alternativeAccepted: OperationCheck<Planned> = defineCheck<Planned>({
	id: ID,
	needs: "a read whose security documents a second alternative of one scheme",
	plan: (ctx) =>
		andThen(declaredPlan(ctx), () =>
			andThen(when(isReadMethod(ctx.operation), "a read: a write an alternative is accepted on would apply it"), () => {
				const alternatives = singleSchemes({ alternatives: ctx.security.alternatives.slice(1) })
				if (alternatives.length === 0) return cannot("an alternative of one scheme besides the first")
				return andThen(addressOf(ctx), (address) => ready({ address, alternatives }))
			}),
		),
	async run(ctx, { address, alternatives }) {
		let outcome: Outcome | undefined
		const untested: string[] = []
		const acting = acceptorOf(ctx).id
		for (const requirement of alternatives) {
			const sent = await attempt(ctx, address, { principal: acting, scheme: requirement.scheme })
			if (sent instanceof UnsatisfiedSecurity) untested.push(sent.reason)
			else if (refused(sent.status)) outcome = await compared(ctx, address, { requirement, sent })
			else outcome ??= ASSERTED
		}
		return outcome ?? standDown(untested.join("; "))
	},
	subject: "operation",
})

/**
 * The request to compare a refusal with: the first alternative, as it is, sent by the same principal
 * as the alternative (`acceptorOf`), and its name in words.
 */
export function controlOf(ctx: Pick<OperationContext, "actor" | "principals" | "security" | "target">): {
	as: Actor
	named: string
} {
	const first = ctx.security.alternatives.slice(0, 1).flat()
	const named = describeSecurity({ alternatives: [first] })
	const [only, ...rest] = first
	if (only === undefined) return { as: { anonymous: true }, named }
	const principal = acceptorOf(ctx).id
	return rest.length === 0 ? { as: { principal, scheme: only.scheme }, named } : { as: { principal }, named }
}

/* Sends a request expecting an answer; a security the actor cannot meet comes back rather than throwing. */
async function attempt(ctx: OperationContext, address: Address, as: Actor): Promise<Exchange | UnsatisfiedSecurity> {
	try {
		return await send(ctx, address, as, "answer")
	} catch (error) {
		if (error instanceof UnsatisfiedSecurity) return error
		throw error
	}
}

/* A refused alternative, judged against the first: a contract broken only when the first is answered. */
async function compared(
	ctx: OperationContext,
	address: Address,
	refusal: { requirement: Requirement; sent: Exchange },
): Promise<Outcome> {
	const { requirement, sent } = refusal
	const { scheme } = requirement
	const control = controlOf(ctx)
	const answered = await attempt(ctx, address, control.as)
	if (answered instanceof UnsatisfiedSecurity) {
		const reason = `${ctx.subject} refused ${scheme}, and ${control.named} could not be sent to compare: ${answered.reason}`
		return ctx.findings.unresolved(ID, ctx.subject, reason)
	}
	if (refused(answered.status)) {
		const reason = `${ctx.subject} refused ${control.named} as well (${answered.status}), so the refusal of ${scheme} says nothing of that alternative`
		return ctx.findings.unresolved(ID, ctx.subject, reason)
	}
	/* Only a success shows the actor may make the request: a 404 or a server error proves no access to compare with. */
	if (answered.status < 200 || answered.status >= 300) {
		const reason = `${ctx.subject} answered ${control.named} with ${answered.status}, not a success, so the refusal of ${scheme} says nothing of that alternative`
		return ctx.findings.unresolved(ID, ctx.subject, reason)
	}
	return ctx.findings.backend(ID, ctx.subject, {
		detail:
			`${ctx.subject} answered ${sent.status} to ${acceptorOf(ctx).id}'s ${scheme} credential, though the document accepts ` +
			`${describeSecurity({ alternatives: [[requirement]] })} on its own. The same request with ${control.named} answered ${answered.status}.`,
		evidence: [sent, answered],
		summary: "an operation refused a credential one of its documented alternatives accepts",
	})
}
