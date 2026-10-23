/** The request body a create sends, as its schema. */

import { requestContent } from "../../spec/collection/request.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { isObject } from "../generate/algebra.ts"
import type { JsonSchema } from "../../spec/types.ts"

export function requestSchemaOf(op: OperationModel, model: SpecModel): JsonSchema | null {
	const raw = model.rawOperations.get(op.operationId)
	if (raw === undefined) throw new Error(`${op.operationId} is not an operation of this model`)
	const picked = requestContent(raw)
	return picked === null ? null : picked.schema
}

/** Top-level properties of a request schema that hold text. */
export function stringProperties(schema: JsonSchema | null): string[] {
	const properties = (schema?.properties ?? {}) as Record<string, unknown>
	return Object.entries(properties)
		.filter(([, property]) => {
			const type = isObject(property) ? property.type : undefined
			return type === "string" || (Array.isArray(type) && type.includes("string"))
		})
		.map(([name]) => name)
}
