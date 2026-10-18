import { defineCheck } from "../../core/define.ts"
import { fillPath } from "../../../fill-path.ts"
import { type Outcome, standDown } from "../../../finding.ts"
import { overMaxLength } from "../../../generate.ts"
import { andThen, cannot, ready } from "../../core/plan.ts"
import { encodeOpBody, validBody } from "../../payloads/body.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { type ConstrainedField, type CreateBody, createBodyPlan, findConstrained } from "./bodies.ts"

export const maxLengthValidated = defineCheck<CreateBody & { target: ConstrainedField }>({
	plan: (ctx) =>
		andThen(createBodyPlan(ctx), (create) => {
			const target = findConstrained(
				create.schema,
				(s) => typeof s.maxLength === "number" && (s.maxLength as number) < 4096,
			)
			return target === null ? cannot("a request field that declares a maxLength") : ready({ ...create, target })
		}),
	mutates: true,
	id: "validation.max-length-enforced",
	needs: "a request schema with a maxLength constraint",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, schema, target }): Promise<Outcome> {
		const max = target.schema.maxLength as number
		const over = overMaxLength(target.schema)
		if (!over.ok) return standDown(over.reason)
		const value = over.value as string
		const body = { ...validBody(ctx, schema), [target.name]: value }
		const exchange = await asProbe(ctx).client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, body)),
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["validation"], exchange)
		if (refused !== null) return refused

		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"a string longer than the declared maxLength was accepted",
			`"${target.name}" declares maxLength ${max} but a ${value.length}-character value was stored ` +
				`(${exchange.status}). The constraint exists in the document only.`,
			[exchange],
		)
	},
})
