import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { fillPath } from "../../../fill-path.ts"
import { type Outcome, standDown } from "../../../finding.ts"
import { andThen, cannot, ready } from "../../core/plan.ts"
import { encodeOpBody, validBody } from "../../payloads/body.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { type CreateBody, createBodyPlan } from "./bodies.ts"

export const requiredValidated: Check<CreateBody & { field: string }> = defineCheck<CreateBody & { field: string }>({
	plan: (ctx) =>
		andThen(createBodyPlan(ctx), (create) => {
			const required = Array.isArray(create.schema.required) ? (create.schema.required as string[]) : []
			const field = required[0]
			return field === undefined ? cannot("a request body with a required field") : ready({ ...create, field })
		}),
	mutates: true,
	id: "validation.required-enforced",
	needs: "a request schema with a required field",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, field, schema }): Promise<Outcome> {
		const { [field]: _omitted, ...body } = validBody(ctx, schema)
		const exchange = await asProbe(ctx).client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, body, { omit: new Set([field]) })),
			as: { principal: ctx.actor.id },
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["validation"], exchange)
		if (refused !== null) return refused

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "create succeeded without a required field",
			detail:
				`"${field}" is listed in the schema's required array, but omitting it returned ` +
				`${exchange.status}. Either the handler does not validate it or the document ` +
				"overstates the requirement.",
			evidence: [exchange],
		})
	},
})
