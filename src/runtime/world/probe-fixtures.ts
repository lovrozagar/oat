import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { buildCohort, isOverflowError, overflowFrom } from "../fixture.ts"
import { requestSchemaOf } from "./schema.ts"

/**
 * Walk each create schema the way seed will. A cycle that still overflows is a named gap on
 * that operation — plan and doctor must not throw `RangeError` either.
 */
export function probeCreateFixtures(model: SpecModel): void {
	for (const entity of model.entities.values()) {
		if (entity.create === undefined) continue
		/* A create id names an operation of the model. */
		const op = model.byOperationId.get(entity.create) as OperationModel
		const schema = requestSchemaOf(op, model) ?? {}
		try {
			buildCohort(schema, 1, ["baseline"], op.operationId, { defs: model.defs })
		} catch (error) {
			if (isOverflowError(error)) {
				const overflow = overflowFrom(error, op.operationId)
				model.gaps.record(op.operationId, "fixture", overflow.message)
			}
		}
	}
}
