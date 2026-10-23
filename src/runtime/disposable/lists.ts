/**
 * The list one level up from a destructive route, read for the id it needs and again to see the
 * record gone; and the body a destructive call sends.
 */

import type { JsonSchema, OperationObject } from "../../spec/types.ts"
import { effective } from "../../spec/collection/effective.ts"
import { deriveIdentity } from "../../spec/collection/identity.ts"
import { successSchema } from "../../spec/collection/responses.ts"
import { deriveCollectionShape } from "../../spec/collection/shape.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"

/** The collection shape `list` answers with. Every operation of a built model has its raw operation. */
function shapeOf(list: OperationModel, model: SpecModel): ReturnType<typeof deriveCollectionShape> {
	return deriveCollectionShape(successSchema(model.rawOperations.get(list.operationId) as OperationObject))
}

export function recordsOf(body: unknown, op: OperationModel, model: SpecModel): Record<string, unknown>[] {
	const shape = shapeOf(op, model)
	if (body === null || typeof body !== "object") return []
	const value = shape?.key === null || shape?.key === undefined ? body : (body as Record<string, unknown>)[shape.key]
	if (!Array.isArray(value)) return []
	return value.filter(
		(item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
	)
}

export function identityOf(list: OperationModel, model: SpecModel, param: string): string {
	const shape = shapeOf(list, model)
	const props = effective(shape?.itemSchema ?? null)?.properties
	if (props !== null && props !== undefined && typeof props === "object" && param in props) return param
	return deriveIdentity(shape?.itemSchema ?? null, param) ?? "id"
}

/** The collection read one level up — `GET /a/{id}` lists for `DELETE /a/{id}/b/{item}`. */
export function parentList(model: SpecModel, op: OperationModel): OperationModel | undefined {
	const parent = op.path.replace(/\/\{[^}]+\}$/, "")
	return model.operations.find((item) => item.method.toUpperCase() === "GET" && item.path === parent)
}

/** The generated body with every field the signup already knows by name; none without a schema. */
export function bodyFor(
	schema: JsonSchema | null,
	known: Record<string, unknown>,
	generated: Record<string, unknown>,
): unknown {
	if (schema === null) return undefined
	const out = { ...generated }
	const props = schema.properties
	if (props !== null && props !== undefined && typeof props === "object") {
		for (const name of Object.keys(props)) if (name in known) out[name] = known[name]
	}
	return out
}
