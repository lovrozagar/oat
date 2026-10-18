/** The request body a create sends, as its schema. */

import { requestContent } from "../../spec/collection/request.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { isPlainRecord } from "./records.ts"

export function requestSchemaOf(op: OperationModel, model: SpecModel): Record<string, unknown> | null {
	const raw = model.rawOperations.get(op.operationId)
	if (raw === undefined) throw new Error(`${op.operationId} is not an operation of this model`)
	const picked = requestContent(raw)
	return picked === null ? null : picked.schema
}

/** Top-level properties of a request schema that hold text. */
export function stringProperties(schema: Record<string, unknown> | null): string[] {
	const properties = (schema?.properties ?? {}) as Record<string, unknown>
	return Object.entries(properties)
		.filter(([, property]) => {
			const type = isPlainRecord(property) ? property.type : undefined
			return type === "string" || (Array.isArray(type) && type.includes("string"))
		})
		.map(([name]) => name)
}
