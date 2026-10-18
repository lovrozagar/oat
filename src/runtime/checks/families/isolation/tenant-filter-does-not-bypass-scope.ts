import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world.ts"
import { cannot, ready } from "../../core/plan.ts"
import { NO_IDENTITY, subjectsOf } from "../../planning/subjects.ts"
import { conv, filterable, filterIdentity, identityIsFilterable, pageSize, q } from "../../query/capabilities.ts"
import { ids, list } from "../../sets/list.ts"
import { tenantBoundary } from "./tenant.ts"

export const crossTenantFilterBypass = defineCheck<{
	id: string
	tenantTerm: Record<string, string>
	altAuth: () => Record<string, string>
	altScope: Record<string, string>
}>({
	plan: (ctx) => {
		const { altAuth, altScope } = ctx
		const target = ctx.records[0]
		if (altAuth === undefined || altScope === undefined || target === undefined) return cannot()
		if (!filterable(ctx) || !tenantBoundary(ctx.listOp) || !identityIsFilterable(ctx)) return cannot()
		const id = idOf(target, ctx.identity)
		if (id === undefined) return cannot(NO_IDENTITY)
		const tenantTerm = filterTerm(conv(ctx), filterIdentity(ctx), "eq", id)
		if (tenantTerm === null) return cannot("a filter grammar that can express equality on the identity")
		return ready({ altAuth, altScope, id, tenantTerm })
	},
	/* The probe filters, so anything that stops a filter from selecting over the whole collection
	 * hides the very record whose visibility is in question — a leak that cannot be observed is
	 * not a leak that can be reported. */
	dependsOn: ["query.filter-selects-from-whole-set"],
	id: "tenant.filter-does-not-bypass-scope",
	needs: "a second principal, a filter, and a tenant tagged or inferred from the path",
	subjects: subjectsOf.list,
	async run(ctx, { altAuth, altScope, id, tenantTerm }): Promise<Outcome> {
		const result = await list(
			ctx,
			{ ...q(ctx, { limit: pageSize(ctx) }), ...tenantTerm },
			{ auth: altAuth, scope: altScope },
		)
		if (result.exchange.status >= 400) return ASSERTED
		if (!ids(result.items, ctx.identity).includes(id)) return ASSERTED

		/* Same split as the item check. A public catalogue has no tenant at all — a 200 for
		 * `id.eq.<someone else's public row>` is the contract, not a leak. */
		const tenantDeclared = ctx.listOp.tenantSource === "tag"
		const detail =
			`a principal in another tenant filtered on ${ctx.identity}.eq.${id} and received the ` +
			"record. The tenant predicate is applied to the base listing but not re-applied to " +
			"filter matches, so any caller who can guess an id can read it."

		if (tenantDeclared) {
			return ctx.findings.security(
				this.id,
				ctx.entityName,
				"a filter reaches records outside the caller's tenant",
				`${detail} The list declares x-tenant: "${ctx.listOp.tenantParam}", so this crosses ` +
					"a boundary the document states exists.",
				[result.exchange],
			)
		}

		ctx.findings.report({
			check: this.id,
			detail:
				`${detail} oat inferred tenant scoping from the "${ctx.listOp.tenantParam}" path ` +
				"parameter; the document does not state it. A public catalogue has no tenant at all — " +
				"no x-tenant and no tenant-named path parameter — and this check then does not apply. " +
				"If the resource is not shared, declare x-tenant so the same 200 is SECURITY.",
			entity: ctx.entityName,
			evidence: [result.exchange],
			summary: "a filter crosses an inferred tenant boundary; the document does not say whether that is intended",
			verdict: "AMBIGUITY",
		})
		return ASSERTED
	},
})
