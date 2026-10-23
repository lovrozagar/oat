import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { requestContent } from "../../../../spec/collection/request.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import { documentsStatus } from "../../../../spec/graph/statuses.ts"
import { fillPath } from "../../../fill-path.ts"
import { type Outcome, standDown } from "../../../finding.ts"
import { cannot } from "../../core/plan.ts"
import { encodeOpBody, validBody } from "../../payloads/body.ts"
import { asProbe, judgeRefusal } from "../../planning/refusal.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { type CreateBody, createBodyPlan } from "./bodies.ts"

export const contentTypeEnforced: Check<CreateBody> = defineCheck<CreateBody>({
	plan: (ctx) =>
		ctx.createOp !== undefined && documentsStatus(ctx.createOp.statuses, 415) ? createBodyPlan(ctx) : cannot(),
	mutates: true,
	id: "validation.content-type-enforced",
	needs: "a documented 415 response",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, schema }): Promise<Outcome> {
		/* The body the endpoint would parse, under a label it does not accept: a server that skips
		 * the check must then process it, rather than refuse it for some unrelated reason. */
		const encoded = await encodeOpBody(ctx, createOp, validBody(ctx, schema))
		const declaredMediaType = declaredMediaTypeOf(ctx.model.rawOperations.get(createOp.operationId))
		const exchange = await asProbe(ctx).client.request("POST", fillPath(createOp.path, ctx.scope), {
			body: asText(encoded.body),
			contentType: "text/plain",
			as: { principal: ctx.actor.id },
		})
		if (standDownForFeatureGate(ctx, createOp, exchange, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["content-type"], exchange)
		if (refused !== null) return refused

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "a request labelled with an undeclared content type was processed",
			detail:
				`the operation documents 415 and declares ${declaredMediaType}, but the same body sent as ` +
				`text/plain was processed (${exchange.status}). Content negotiation is documented ` +
				"but not implemented.",
			evidence: [exchange],
		})
	},
})

/** The media type the operation declares for its request body, as a finding names it. */
export function declaredMediaTypeOf(raw: OperationObject | undefined): string {
	return raw === undefined ? "a declared media type" : (requestContent(raw)?.mediaType ?? "a declared media type")
}

/** An encoded body as the text sent under the undeclared label: a form as its query string. */
export function asText(body: unknown): string {
	return body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : JSON.stringify(body)
}
