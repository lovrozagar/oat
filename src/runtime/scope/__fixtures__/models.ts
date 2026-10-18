import { buildSpec } from "../../../reference/spec/build.ts"
import { buildModel } from "../../../spec/graph/build.ts"
import type { EntityModel, SpecModel } from "../../../spec/graph/types.ts"
import { dereference } from "../../../spec/load/dereference.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"

/** The reference backend's own document, as oat models it. */
export function referenceModel(): SpecModel {
	return buildModel(dereference(buildSpec() as OpenApiDocument).doc)
}

/** One operation no check judges and no entity owns. */
export function payModel(): SpecModel {
	return buildModel({
		info: { title: "vacuous", version: "1" },
		openapi: "3.1.0",
		paths: { "/v1/pay": { post: { operationId: "pay.start", responses: { "200": { description: "ok" } } } } },
	} as unknown as OpenApiDocument)
}

/** An entity of `model`, which must have it. */
export function entityOf(model: SpecModel, name: string): EntityModel {
	const entity = model.entities.get(name)
	if (entity === undefined) throw new Error(`the model has no ${name}`)
	return entity
}
