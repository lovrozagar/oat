import { defineCheck } from "../../core/define.ts"
import type { Exchange } from "../../../client.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { sameTenantScope } from "../../isolation/scratch.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { fillPath } from "../../../fill-path.ts"
import {
	canRead,
	type Flow,
	type InvitePlan,
	inviteFlow,
	inviteToken,
	pointerValue,
	revoke,
	sendAccept,
} from "./invite-flow.ts"

/**
 * Delegated access is a flow, not a request: B cannot read A's record, A invites B, B accepts,
 * B can read, A revokes, B cannot. Each step is a capability statement the next one depends on.
 * A grant that appears before accept, never appears, or survives revoke is a different bug
 * at the same check — the timeline is the property.
 */
export const inviteGrantsThenRevokes = /* @__PURE__ */ defineCheck<InvitePlan>({
	mutates: true,
	plan: (ctx) => {
		const spec = ctx.invite
		const owner = ctx.actors[0]
		if (spec === null || owner === undefined) return cannot()
		const delegate =
			ctx.actors.find(
				(actor) => actor !== owner && actor.inviteAs !== undefined && !sameTenantScope(actor.roots, owner.roots),
			) ?? ctx.actors.find((actor) => actor !== owner && actor.inviteAs !== undefined)
		if (delegate?.inviteAs === undefined) {
			return cannot("a peer principal declaring inviteAs, so the grantee field need not be invented")
		}
		const inviteOp = ctx.model.byOperationId.get(spec.invite)
		const acceptOp = ctx.model.byOperationId.get(spec.accept)
		const revokeOp = ctx.model.byOperationId.get(spec.revoke)
		if (inviteOp === undefined || acceptOp === undefined || revokeOp === undefined) {
			return cannot("x-invite operations that exist in the document")
		}
		const grantsOp = spec.grants === undefined ? undefined : ctx.model.byOperationId.get(spec.grants)
		if (spec.grants !== undefined && grantsOp === undefined)
			return cannot("an x-invite.grants read that exists in the document")
		return ready({ acceptOp, delegate, grantsOp, inviteAs: delegate.inviteAs, inviteOp, owner, revokeOp, spec })
	},
	dependsOn: ["list.read-after-write", "tenant.item-not-readable-cross-tenant"],
	id: "auth.invite-grants-then-revokes",
	needs: "x-invite naming invite/accept/revoke, a peer principal with inviteAs, and an item or list route",
	subjects: subjectsOf.invite,
	async run(ctx, plan): Promise<Outcome> {
		const flow = inviteFlow(ctx, this.id, plan)
		if ((await canRead(flow)) === true) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"the delegate could already read the record, so invite cannot be distinguished from a leak",
			)
		}

		const { inviteOp, owner, spec } = plan
		const invited = await ctx.client.request(inviteOp.method, fillPath(inviteOp.path, flow.resource), {
			body: { [spec.granteeField]: plan.inviteAs },
			headers: { ...owner.headers(), "content-type": "application/json" },
			operationId: inviteOp.operationId,
		})
		if (standDownForFeatureGate(ctx, inviteOp, invited, this.id))
			return standDown("a documented feature gate refused the request")
		if (invited.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`invite returned ${invited.status}, so accept/revoke were never exercised`,
			)
		}
		const grantId = pointerValue(invited.responseBody, spec.grantPointer)
		/* From here a grant exists, accepted or not. Whatever this check concludes, the access it
		 * handed out is taken back before it returns. */
		try {
			const accepted = await acceptInvite(flow, invited)
			if ("outcome" in accepted) return accepted.outcome
			return await revokeGrant(flow, [invited, accepted.exchange], grantId)
		} finally {
			if (!flow.revoked && grantId !== undefined) await revoke(flow, grantId).catch(() => undefined)
		}
	},
})

/**
 * The delegate accepts: no access before it, the token from the answer or out of band, the
 * accept itself, then access. The accept exchange, or the outcome that ended the flow.
 */
async function acceptInvite(flow: Flow, invited: Exchange): Promise<{ exchange: Exchange } | { outcome: Outcome }> {
	const { check, ctx, plan } = flow
	const { delegate, spec } = plan
	if ((await canRead(flow)) === true) {
		const outcome = ctx.findings.backend(
			check,
			ctx.entityName,
			"an invite grants access before it is accepted",
			`inviting ${delegate.id} made ${flow.subjectLabel} readable immediately. The accept ` +
				"step is then theatre — anyone who can be named in an invite body is already in.",
			[invited],
		)
		return { outcome }
	}
	const token = await inviteToken(flow, invited)
	if (typeof token !== "string") return token
	flow.token = token
	const accepted = await sendAccept(flow, token)
	if ("outcome" in accepted) return accepted
	if (spec.acceptFrom !== "link" && standDownForFeatureGate(ctx, plan.acceptOp, accepted.exchange, check))
		return { outcome: standDown("a documented feature gate refused the request") }
	const status = accepted.exchange.status
	const acceptFailed = spec.acceptFrom === "link" ? status >= 400 : status >= 300
	if (acceptFailed) return { outcome: ctx.findings.unresolved(check, ctx.entityName, `accept returned ${status}`) }
	const issued = pointerValue(accepted.exchange.responseBody, spec.credentialFrom)
	if (issued !== undefined) delegate.adoptCredential?.(issued)
	if ((await canRead(flow)) === false) {
		const outcome = ctx.findings.backend(
			check,
			ctx.entityName,
			"accepting an invite does not grant access",
			`${delegate.id} accepted an invite and still cannot read ${flow.subjectLabel}. ` +
				"The invite flow completed; the grant did not.",
			[invited, accepted.exchange],
		)
		return { outcome }
	}
	return accepted
}

/** The owner revokes the accepted grant; access that survives it is the finding. */
async function revokeGrant(flow: Flow, evidence: [Exchange, Exchange], grantId: string | undefined): Promise<Outcome> {
	const { check, ctx, plan } = flow
	const { spec } = plan
	if (grantId === undefined) {
		return ctx.findings.unresolved(
			check,
			ctx.entityName,
			`invite response has no grant id at ${spec.grantPointer}, so revoke cannot be expressed`,
		)
	}
	const revoked = await revoke(flow, grantId)
	if (standDownForFeatureGate(ctx, plan.revokeOp, revoked, check))
		return standDown("a documented feature gate refused the request")
	if (revoked.status >= 300) return ctx.findings.unresolved(check, ctx.entityName, `revoke returned ${revoked.status}`)
	if ((await canRead(flow)) === true) {
		ctx.findings.backend(
			check,
			ctx.entityName,
			"revoking an invite does not remove access",
			`${plan.delegate.id} can still read ${flow.subjectLabel} after the grant was revoked. ` +
				"A share that cannot be taken back is a standing leak.",
			[...evidence, revoked],
		)
	}
	return ASSERTED
}
