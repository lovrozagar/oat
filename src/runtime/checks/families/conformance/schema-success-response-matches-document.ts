import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import type { OperationObject } from "../../../../spec/types.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import type { SchemaValidator } from "../../../validate.ts"
import { cannot, ready } from "../../core/plan.ts"
import { createExchange } from "../../payloads/body.ts"
import { isEventStream, subjectsOf } from "../../planning/subjects.ts"

export const successSchemaHonoured = /* @__PURE__ */ defineCheck<{
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
		if (!validator.documents(raw, exchange.status)) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`create returned ${exchange.status}, which the document declares no schema for — ` +
					"there is nothing to validate the body against",
			)
		}

		const result = validator.validate(createOp.operationId, raw, exchange.status, exchange.responseBody)
		if (result.unchecked !== undefined) {
			return ctx.findings.gap(
				this.id,
				ctx.entityName,
				`${createOp.operationId} ${exchange.status} has a schema that cannot be compiled`,
				`AJV refused the documented schema, so the body was not validated: ${result.unchecked}`,
			)
		}
		if (result.ok) return ASSERTED

		return ctx.findings.spec(
			this.id,
			ctx.entityName,
			"success response does not match its documented schema",
			`${createOp.operationId} returned ${exchange.status} with a body that fails the declared ` +
				`schema: ${result.errors.join("; ")}. Either the handler returns more than it promises ` +
				"or the document is out of date — both break generated clients.",
			[exchange],
		)
	},
})
