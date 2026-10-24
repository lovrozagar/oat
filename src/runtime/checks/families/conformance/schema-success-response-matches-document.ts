import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import type { SchemaValidator } from "../../../validate.ts"
import { cannot, ready } from "../../core/plan.ts"
import { createExchange } from "../../payloads/body.ts"
import { isEventStream, subjectsOf } from "../../planning/subjects.ts"

export const successSchemaHonored: Check<{
	createOp: OperationModel
	validator: SchemaValidator
	raw: OperationObject
}> = defineCheck<{
	createOp: OperationModel
	validator: SchemaValidator
	raw: OperationObject
}>({
	plan: (ctx) => {
		const { createOp, validator } = ctx
		if (createOp === undefined || validator === undefined) return cannot()
		const raw = ctx.model.rawOperations.get(createOp.operationId)
		return raw === undefined ? cannot() : ready({ createOp, raw, validator })
	},
	/* The body is validated against the schema declared *for the status that came back*. When the
	 * status itself is undocumented there is no schema to validate against, and the right finding
	 * is the status one — not silence. */
	dependsOn: ["create.status-matches-document"],
	id: "schema.success-response-matches-document",
	judgesTranscript: true,
	needs: "a documented success schema on create",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, raw, validator }): Promise<Outcome> {
		const exchange = await createExchange(ctx)
		if (exchange === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, "no successful create was observed")
		if (isEventStream(exchange, createOp)) return standDown("the create answers with an event stream")
		/* A create documented to answer with no body — a 201 naming the record in `Location` — and
		 * answering none matches its document. */
		if (validator.documentsNoBody(raw, exchange.status) && emptyBody(exchange.responseBody)) return ASSERTED
		if (!validator.documents(raw, exchange.status)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`create returned ${exchange.status}, which the document declares no schema for — ` +
					"there is nothing to validate the body against",
			)
		}

		const result = validator.validate(createOp.operationId, raw, exchange)
		if (result.unchecked !== undefined) {
			return ctx.findings.gap(this.id, ctx.entityName, {
				summary: `${createOp.operationId} ${exchange.status} has a schema that cannot be compiled`,
				detail: `AJV refused the documented schema, so the body was not validated: ${result.unchecked}`,
			})
		}
		if (result.ok) return ASSERTED

		return ctx.findings.spec(this.id, ctx.entityName, {
			summary: "success response does not match its documented schema",
			detail:
				`${createOp.operationId} returned ${exchange.status} with a body that fails the declared ` +
				`schema: ${result.errors.join("; ")}. Either the handler returns more than it promises ` +
				"or the document is out of date — both break generated clients.",
			evidence: [exchange],
		})
	},
})

function emptyBody(body: unknown): boolean {
	return body === null || body === undefined || body === ""
}
