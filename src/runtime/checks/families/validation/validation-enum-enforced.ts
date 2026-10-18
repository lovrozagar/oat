import { defineCheck } from "../../core/define.ts"
import { fillPath } from "../../../fill-path.ts"
import { type Outcome, standDown } from "../../../finding.ts"
import { outsideEnum } from "../../../generate/probes.ts"
import { andThen, cannot, ready } from "../../core/plan.ts"
import { encodeOpBody, validBody } from "../../payloads/body.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { type ConstrainedField, type CreateBody, createBodyPlan, findConstrained } from "./bodies.ts"

export const enumValidated = defineCheck<CreateBody & { target: ConstrainedField }>({
	plan: (ctx) =>
		andThen(createBodyPlan(ctx), (create) => {
			const target = findConstrained(create.schema, (s) => Array.isArray(s.enum) && s.enum.length > 0)
			return target === null ? cannot("a request field that declares an enum") : ready({ ...create, target })
		}),
	mutates: true,
	id: "validation.enum-enforced",
	needs: "a request schema with an enum field",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, schema, target }): Promise<Outcome> {
		const outside = outsideEnum(target.schema)
		if (!outside.ok) return ctx.findings.unresolved(this.id, ctx.entityName, outside.reason)
		const body = { ...validBody(ctx, schema), [target.name]: outside.value }
		const exchange = await asProbe(ctx).client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, body)),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["validation"], exchange)
		if (refused !== null) return refused

		const declaredValues = (target.schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a value outside the declared enum was accepted",
			`"${target.name}" declares [${declaredValues}] but the backend accepted ${JSON.stringify(outside.value)} ` +
				`with ${exchange.status}. Clients generated from this document will assume the field ` +
				"only ever holds a declared member.",
			[exchange],
		)
	},
})
