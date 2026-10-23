/** The schema of one record of the entity, whichever route it is read from. */

import { asSchema, effective } from "../../../spec/collection/effective.ts"
import { successSchema } from "../../../spec/collection/responses.ts"
import type { OperationModel, SpecModel } from "../../../spec/graph/types.ts"
import type { JsonSchema } from "../../../spec/types.ts"

/** Where the record's schema is read from: the entity's list, else its item read. */
export interface ItemRoutes {
	listOp: OperationModel | undefined
	readOp: OperationModel | undefined
	model: Pick<SpecModel, "rawOperations">
}

/**
 * The record's schema: the list's rows when the entity has a list, else what its item read
 * answers with, where its `x-entity.recordPath` says the record is. `null` when neither says.
 */
export function itemSchemaOf({ listOp, model, readOp }: ItemRoutes): JsonSchema | null {
	if (listOp !== undefined) return listOp.collection?.itemSchema ?? null
	const raw = readOp === undefined ? undefined : model.rawOperations.get(readOp.operationId)
	if (readOp === undefined || raw === undefined) return null
	const answer = effective(successSchema(raw))
	return readOp.recordPath === null ? answer : schemaAt(answer, readOp.recordPath)
}

/**
 * The schema of the node `path` names, read as `readPath` reads a body: a dotted path or a JSON
 * pointer, an index, `[*]` or a filter naming an array's items.
 */
function schemaAt(schema: JsonSchema | null, path: string): JsonSchema | null {
	const segments = path.startsWith("/")
		? path
				.slice(1)
				.split("/")
				.map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~"))
		: path
				.replace(/^\$\.?/, "")
				.replace(/\[(\d+|\*|\?\([^)]*\))\]/g, ".[]")
				.split(".")
	return segments.filter(Boolean).reduce<JsonSchema | null>((node, segment) => {
		if (node === null) return null
		if (node.type === "array") return segment === "[]" || /^\d+$/.test(segment) ? effective(asSchema(node.items)) : null
		return effective(asSchema(asSchema(node.properties)?.[segment]))
	}, schema)
}
