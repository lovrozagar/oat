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

/**
 * A `key` entity whose create, `key.create`, answers `created` (a 201 response), or documents no
 * response when it is `undefined`, and is tagged with `tag`.
 */
export function keyModel(created?: unknown, tag: Record<string, unknown> = {}): SpecModel {
	const item = { in: "path", name: "id", required: true, schema: { type: "string" } }
	const record = {
		content: { "application/json": { schema: { properties: { id: { type: "string" } }, type: "object" } } },
	}
	return buildModel({
		info: { title: "keys", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/keys": {
				post: {
					operationId: "key.create",
					...(created === undefined ? {} : { responses: { "201": created } }),
					"x-entity": { action: "create", name: "key", ...tag },
				},
			},
			"/v1/keys/{id}": {
				delete: {
					operationId: "key.delete",
					parameters: [item],
					responses: { "204": { description: "gone" } },
					"x-entity": { action: "delete", identity: "id", name: "key" },
				},
				get: {
					operationId: "key.get",
					parameters: [item],
					responses: { "200": { ...record, description: "the key" } },
					"x-entity": { action: "read", identity: "id", name: "key" },
				},
			},
		},
	} as unknown as OpenApiDocument)
}

/** An entity of `model`, which must have it. */
export function entityOf(model: SpecModel, name: string): EntityModel {
	const entity = model.entities.get(name)
	if (entity === undefined) throw new Error(`the model has no ${name}`)
	return entity
}
