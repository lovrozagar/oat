import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { buildCohort, overflowFrom } from "../fixture.ts"
import { requestSchemaOf } from "./schema.ts"

/**
 * Walk each create schema the way seed will. A body that cannot be generated, for whatever reason,
 * is a named gap on that operation — plan and doctor must not throw, and must not stay silent.
 */
export function probeCreateFixtures(model: SpecModel): void {
	for (const entity of model.entities.values()) {
		if (entity.create === undefined) continue
		/* A create id names an operation of the model. */
		const op = model.byOperationId.get(entity.create) as OperationModel
		const schema = requestSchemaOf(op, model) ?? {}
		try {
			buildCohort(schema, 1, { variants: ["baseline"], defs: model.defs, operationId: op.operationId })
		} catch (error) {
			/* Generation reports every failure as an overflow naming why: never silence. */
			model.gaps.record(op.operationId, "fixture", overflowFrom(error, op.operationId).message)
		}
	}
}
