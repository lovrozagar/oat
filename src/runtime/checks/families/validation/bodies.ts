import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { CheckContext } from "../../core/context.ts"
import { cannot, type Plan, ready } from "../../core/plan.ts"
import { requestSchemaOf } from "../../payloads/body.ts"

/** The create operation and its request schema: what every create-validation probe starts from. */
export interface CreateBody {
	createOp: OperationModel
	schema: Record<string, unknown>
}

export function createBodyPlan(ctx: CheckContext): Plan<CreateBody> {
	const createOp = ctx.createOp
	if (createOp === undefined) return cannot()
	const schema = requestSchemaOf(ctx, createOp)
	return schema === null ? cannot("a create operation with a request schema") : ready({ createOp, schema })
}

export interface ConstrainedField {
	name: string
	schema: Record<string, unknown>
}

export function findConstrained(
	schema: Record<string, unknown>,
	predicate: (s: Record<string, unknown>) => boolean,
): ConstrainedField | null {
	const props = schema.properties
	if (props === null || typeof props !== "object") return null
	for (const [name, raw] of Object.entries(props as Record<string, Record<string, unknown>>)) {
		if (raw === null || typeof raw !== "object") continue
		if (raw.readOnly === true) continue
		if (predicate(raw)) return { name, schema: raw }
		const union = raw.oneOf ?? raw.anyOf
		if (Array.isArray(union)) {
			const branch = union.find(
				(candidate) =>
					candidate !== null && typeof candidate === "object" && predicate(candidate as Record<string, unknown>),
			)
			if (branch !== undefined) return { name, schema: branch as Record<string, unknown> }
		}
	}
	return null
}
