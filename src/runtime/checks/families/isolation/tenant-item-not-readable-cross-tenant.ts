import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { fillPath } from "../../../fill-path.ts"
import type { Actor } from "../../core/context.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { itemParamFor, NO_IDENTITY, subjectsOf } from "../../planning/subjects.ts"
import { tenantBoundary } from "./tenant.ts"

export const crossTenantItemRead: Check<{
	id: string
	readOp: OperationModel
	peer: Actor
}> = defineCheck<{
	id: string
	readOp: OperationModel
	peer: Actor
}>({
	plan: (ctx) => {
		const { peer, readOp } = ctx
		const target = ctx.records[0]
		if (peer === undefined || readOp === undefined || target === undefined || !tenantBoundary(readOp)) {
			return cannot()
		}
		const id = idOf(target, ctx.identity)
		return id === undefined ? cannot(NO_IDENTITY) : ready({ id, peer, readOp })
	},
	id: "tenant.item-not-readable-cross-tenant",
	needs: "a second principal in a different tenant, and a tenant tagged or inferred from the path",
	subjects: subjectsOf.read,
	async run(ctx, { id, peer, readOp }): Promise<Outcome> {
		/* The actor's record, asked for by the peer under the peer's own scope. */
		const params = { ...(ctx.peerScope ?? ctx.scope), ...itemParamFor(ctx, id) }
		const exchange = await ctx.client.get(fillPath(readOp.path, params), {
			as: { principal: peer.id },
			operationId: readOp.operationId,
		})
		if (exchange.status === 403 || exchange.status === 404) return ASSERTED
		if (exchange.status >= 400)
			return ctx.findings.unresolved(this.id, ctx.entityName, "the cross-tenant read failed for another reason")

		/* Only assert a breach when the document says the route is tenant-scoped. Where oat merely
		 * guessed scoping from a path parameter, a shared catalogue and a data leak are the same
		 * observation, and claiming the worse one erodes trust in every other finding. */
		const tenantDeclared = readOp.tenantSource === "tag"
		const detail =
			`${ctx.entityName} ${id} was created by one principal and read successfully ` +
			`(${exchange.status}) by a principal in a different tenant.`

		if (tenantDeclared) {
			return ctx.findings.security(this.id, ctx.entityName, {
				summary: "a record is readable by a principal in another tenant",
				detail:
					`${detail} The operation declares x-tenant: "${readOp.tenantParam}", so this ` +
					"crosses a boundary the document states exists.",
				evidence: [exchange],
			})
		}

		ctx.findings.report({
			check: this.id,
			detail:
				`${detail} oat inferred tenant scoping from the "${readOp.tenantParam}" path ` +
				"parameter; the document does not state it. A public catalogue has no tenant at all — " +
				"no x-tenant and no tenant-named path parameter — and this check then does not apply. " +
				"If the resource is not shared, declare x-tenant so the same 200 is SECURITY.",
			entity: ctx.entityName,
			evidence: [exchange],
			summary: "a record crosses an inferred tenant boundary; the document does not say whether that is intended",
			verdict: "AMBIGUITY",
		})
		return ASSERTED
	},
})
