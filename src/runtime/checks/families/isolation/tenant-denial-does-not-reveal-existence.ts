import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf, type Record_ } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { constructedAbsentId } from "../../payloads/identity.ts"
import { asProbe } from "../../planning/refusal.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import { tenantBoundary } from "./tenant.ts"

/**
 * A denial must not reveal whether the record exists.
 *
 * Refusing a cross-tenant read is correct. Refusing it with a *different status* than an id that
 * was never issued is an oracle: an attacker walks the identifier space and reads existence off
 * the status code, learning how many records another tenant holds and which ids are live — all
 * without ever being served a body. The access decision looks right in every log.
 *
 * The comparison is what makes this decidable without knowing the backend's policy. Whichever
 * status it picks is fine; picking two different ones is not.
 */
export const denialDoesNotRevealExistence = defineCheck<{
	target: Record_
	readOp: OperationModel
	altAuth: () => Record<string, string>
}>({
	plan: (ctx) => {
		const { altAuth, readOp } = ctx
		const target = ctx.records[0]
		if (altAuth === undefined || readOp === undefined || target === undefined || !tenantBoundary(readOp)) {
			return cannot()
		}
		return ready({ altAuth, readOp, target })
	},
	dependsOn: [
		/* If the record is readable across tenants at all, that is the finding — how the denial
		 * would have been phrased is beside the point. */
		"tenant.item-not-readable-cross-tenant",
	],
	id: "tenant.denial-does-not-reveal-existence",
	needs: "a second principal in a different tenant, and a tenant tagged or inferred from the path",
	subjects: subjectsOf.read,
	async run(ctx, { altAuth, readOp, target }): Promise<Outcome> {
		const realId = idOf(target, ctx.identity)
		if (realId === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, `the record carries no "${ctx.identity}"`)
		/* Shaped like a real identifier so the difference under test is existence, not format —
		 * a backend may legitimately reject a malformed id differently. */
		const absentProbe = constructedAbsentId(ctx)
		if (absentProbe === null) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"no well-formed identifier that names nothing can be built from the identifier schema",
			)
		}

		const ask = async (id: string): Promise<Exchange> =>
			asProbe(ctx).client.get(fillPath(readOp.path, { ...(ctx.altScope ?? ctx.scope), ...itemParamFor(ctx, id) }), {
				headers: altAuth(),
			})

		const existing = await ask(realId)
		const absent = await ask(absentProbe)

		/* Only a denial pair is meaningful. A 2xx on the existing record is a cross-tenant read,
		 * which the check above owns and this one is suppressed by. */
		if (existing.status < 400 || absent.status < 400) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"one of the two probes was not denied, so there is no pair of denials to compare",
			)
		}
		if (existing.status === absent.status) return ASSERTED

		return ctx.findings.security(this.id, ctx.entityName, {
			summary: "the denial status reveals whether a record exists",
			detail:
				`a record belonging to another tenant was refused with ${existing.status}, while an id ` +
				`that does not exist was refused with ${absent.status}. The difference is an oracle: ` +
				"anyone able to guess or enumerate identifiers can learn which ones are real without " +
				"ever reading one. Both cases must answer identically — conventionally 404.",
			evidence: [existing, absent],
		})
	},
})
